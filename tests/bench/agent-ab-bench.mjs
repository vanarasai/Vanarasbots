#!/usr/bin/env node
// Agent A/B: the same real code-investigation tasks run through the real server-side session runner twice,
// once with code_search withheld and once with it offered, on a local Ollama model (no paid calls).
// Runs in a throwaway clone with its own state and worktrees, so the user's workspace is never touched.
// Usage: node tests/bench/agent-ab-bench.mjs [ollamaModel] [maxSteps]
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODEL = process.argv[2] || "qwen3.5:9b";
const MAX_STEPS = Number(process.argv[3]) || 15;
const OLLAMA = "http://127.0.0.1:11434/v1";

const TASKS = [
  {
    id: "retry",
    question: "When a model request fails, how many times is it retried by default, and how long does it wait between attempts? Name the file and the function.",
    check: a => /queryModelWithRetry/.test(a) && /session-runner/.test(a)
  },
  {
    id: "approval",
    question: "Which HTTP endpoint does the UI call to approve or deny a pending agent command, and how long does the agent wait for an answer before giving up? Name the files involved.",
    check: a => /\/api\/approvals\/respond/.test(a) && /\b60\b|60\s*s|60,?000|sixty/i.test(a)
  },
  {
    id: "vote",
    question: "In a panel's A/B vote, how does the code decide which option a panelist's vote refers to? Name the file and function.",
    check: a => /resolveVote|tallyVotes/.test(a) && /panel-core/.test(a)
  }
];
const ARMS = [
  { id: "without", botId: "bot_ab_without", disabledTools: ["code_search"] },
  { id: "with", botId: "bot_ab_with", disabledTools: [] }
];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on("error", reject);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

const base = fs.mkdtempSync(path.join(os.tmpdir(), "vanaras-ab-"));
const repo = path.join(base, "repo");
execFileSync("git", ["clone", "--local", "--quiet", ROOT, repo]);
for (const line of execFileSync("git", ["status", "--porcelain"], { cwd: ROOT }).toString().split("\n")) {
  if (!line.trim()) continue;
  const rel = line.slice(3).trim().replace(/^.* -> /, "");
  const src = path.join(ROOT, rel);
  if (!/^(?:ui|tests)\//.test(rel) || !fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.copyFileSync(src, path.join(repo, rel));
}
execFileSync("git", ["add", "-A"], { cwd: repo });
try { execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@local", "commit", "-qm", "bench snapshot"], { cwd: repo }); } catch {}

const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(repo, "ui", "server.mjs")], {
  cwd: repo,
  env: { ...process.env, VANARAS_PORT: String(port), VANARAS_STATE_DIR: path.join(base, "state"), VANARAS_WORKTREES_DIR: path.join(repo, ".worktrees") },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverLog = "";
server.stdout.on("data", d => { serverLog += d; });
server.stderr.on("data", d => { serverLog += d; });
const cleanup = () => { try { server.kill("SIGTERM"); } catch {} };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

async function api(method, p, body, timeoutMs = 60000) {
  const res = await fetch(`${url}${p}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  return res.json();
}
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${url}/api/health`)).ok) break; } catch {}
  await sleep(250);
}

for (const arm of ARMS) {
  await api("POST", "/api/agent/skill", { botId: arm.botId, botName: arm.id, action: "set", skillMarkdown: "", agentConfig: { provider: "local", baseUrl: OLLAMA, model: MODEL, permissionPolicy: "auto" } });
}

// The index is a one-time cost per worktree; build it before the timed runs and report it separately.
const t0 = Date.now();
let coverage = 0;
for (let i = 0; i < 40 && coverage < 1; i++) {
  const r = await api("POST", "/api/code-search", { botId: "bot_ab_with", query: "warm up the index", limit: 1 }, 180000);
  coverage = r.semantic?.coverage || 0;
  if (coverage < 1) await sleep(3000);
}
console.log(`index for the "with" arm: ${(coverage * 100).toFixed(0)}% embedded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const prompt = q => `Answer this question about the code in your worktree. Do not modify any files. Investigate with your tools, then give a short answer that names the exact files and functions.\n\nQuestion: ${q}`;
const results = [];
for (const task of TASKS) {
  for (const arm of ARMS) {
    const threadId = `ab_${task.id}_${arm.id}_${Date.now()}`;
    const started = Date.now();
    await api("POST", "/api/sessions/turn", { threadId, botId: arm.botId, botName: arm.id, prompt: prompt(task.question), maxSteps: MAX_STEPS, disabledTools: arm.disabledTools });
    let turn = null;
    while (Date.now() - started < 20 * 60 * 1000) {
      await sleep(3000);
      turn = (await api("GET", `/api/sessions/status?threadId=${encodeURIComponent(threadId)}`)).turn;
      if (turn && turn.status !== "running") break;
    }
    const tools = {};
    for (const c of turn?.toolCalls || []) tools[c.name] = (tools[c.name] || 0) + 1;
    const answer = String(turn?.finalContent || "");
    const row = {
      task: task.id,
      arm: arm.id,
      status: turn?.status || "timeout",
      solved: task.check(answer),
      steps: turn?.step || 0,
      toolCalls: (turn?.toolCalls || []).length,
      tools,
      promptTokens: turn?.usage?.prompt || 0,
      completionTokens: turn?.usage?.completion || 0,
      toolOutputChars: turn?.usage?.toolOutputChars || 0,
      seconds: Math.round((Date.now() - started) / 1000),
      answer: answer.slice(0, 600)
    };
    results.push(row);
    console.log(`${task.id.padEnd(9)} ${arm.id.padEnd(8)} ${row.status.padEnd(10)} solved=${row.solved ? "yes" : "NO "} steps=${String(row.steps).padStart(2)} tools=${JSON.stringify(tools)} tokens=${row.promptTokens}+${row.completionTokens} toolOut=${row.toolOutputChars}ch ${row.seconds}s`);
  }
}

const out = path.join(base, "results.json");
fs.writeFileSync(out, JSON.stringify({ model: MODEL, maxSteps: MAX_STEPS, results }, null, 2));
const tot = arm => results.filter(r => r.arm === arm).reduce((s, r) => ({
  solved: s.solved + (r.solved ? 1 : 0), prompt: s.prompt + r.promptTokens, completion: s.completion + r.completionTokens,
  calls: s.calls + r.toolCalls, out: s.out + r.toolOutputChars, secs: s.secs + r.seconds
}), { solved: 0, prompt: 0, completion: 0, calls: 0, out: 0, secs: 0 });
for (const arm of ARMS) {
  const t = tot(arm.id);
  console.log(`\nTOTAL ${arm.id.padEnd(8)} solved ${t.solved}/${TASKS.length} · tokens ${t.prompt} prompt + ${t.completion} completion · ${t.calls} tool calls · ${t.out} chars of tool output · ${t.secs}s`);
}
console.log(`\nresults: ${out}`);
cleanup();

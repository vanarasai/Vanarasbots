#!/usr/bin/env node
// Agent A/B harness: the same tasks (tests/bench/agent-tasks.mjs) run through the real server-side session
// runner under different search setups, repeated, on a local Ollama model (no paid calls). Runs in a
// throwaway clone with its own server, state and worktrees, so the user's workspace is never touched.
//
//   node tests/bench/agent-ab-bench.mjs [--model qwen3:14b] [--steps 15] [--repeats 2]
//                                       [--arms grep,bm25,hybrid] [--tasks retry,vote] [--out dir]
//
// Each run starts from a clean worktree. Arm order rotates per task so no arm always runs first.
// Reports success, tokens, tool calls and time per arm (mean ± sd across runs), per-task solve counts,
// and writes results.json plus report.md.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "./agent-tasks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const opt = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const MODEL = opt("model", "qwen3:14b");
const MAX_STEPS = Number(opt("steps", 15));
const REPEATS = Math.max(1, Number(opt("repeats", 2)));
const OLLAMA = "http://127.0.0.1:11434/v1";

// grep: no index. bm25: code_search over the keyword index only (XERJ-style). hybrid: BM25 + EmbeddingGemma 2.
const ALL_ARMS = [
  { id: "grep", botId: "bot_ab_grep", disabledTools: ["code_search"], config: {} },
  { id: "bm25", botId: "bot_ab_bm25", disabledTools: [], config: { codeSearchMode: "keyword" } },
  { id: "hybrid", botId: "bot_ab_hybrid", disabledTools: [], config: { codeSearchMode: "hybrid" } }
];
const armFilter = opt("arms", "").split(",").filter(Boolean);
const ARMS = armFilter.length ? ALL_ARMS.filter(a => armFilter.includes(a.id)) : ALL_ARMS;
const taskFilter = opt("tasks", "").split(",").filter(Boolean);
const tasks = taskFilter.length ? TASKS.filter(t => taskFilter.includes(t.id)) : TASKS;
if (!ARMS.length || !tasks.length) throw new Error("no arms or tasks selected");

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on("error", reject);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = xs => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const sd = xs => (xs.length < 2 ? 0 : Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1)));

const base = fs.mkdtempSync(path.join(os.tmpdir(), "vanaras-ab-"));
const outDir = path.resolve(opt("out", base));
fs.mkdirSync(outDir, { recursive: true });
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
  stdio: ["ignore", "ignore", "ignore"]
});
const cleanup = () => { try { server.kill("SIGTERM"); } catch {} };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

// The tasks are about this repository, so the clone is the rooms' project.
async function api(method, p, body, timeoutMs = 60000) {
  const res = await fetch(`${url}${p}`, { method, headers: { "Content-Type": "application/json", "X-Vanaras-Project": encodeURIComponent(repo) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  return res.json();
}
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${url}/api/health`)).ok) break; } catch {}
  await sleep(250);
}

const worktrees = {};
const worktreeOf = arm => worktrees[arm.id];
// Each run starts from the snapshot: earlier edits (and their index entries) must not leak into the next run.
function resetWorktree(arm) {
  const wt = worktreeOf(arm);
  if (!fs.existsSync(wt)) return;
  execFileSync("git", ["reset", "--hard", "-q", "HEAD"], { cwd: wt });
  execFileSync("git", ["clean", "-fdq"], { cwd: wt });
}

for (const arm of ARMS) {
  await api("POST", "/api/agent/skill", { botId: arm.botId, botName: arm.id, action: "set", skillMarkdown: "", agentConfig: { provider: "local", baseUrl: OLLAMA, model: MODEL, permissionPolicy: "auto", ...arm.config } });
  const wt = await api("POST", "/api/agent/worktree", { botId: arm.botId, botName: arm.id, action: "ensure" });
  if (!wt.worktreePath) throw new Error(`could not create a worktree for ${arm.id}: ${JSON.stringify(wt)}`);
  worktrees[arm.id] = wt.worktreePath;
}
// Indexes are a one-time cost per worktree; build them before the timed runs and report them separately.
const indexTimes = {};
for (const arm of ARMS.filter(a => a.id !== "grep")) {
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) {
    const r = await api("POST", "/api/code-search", { botId: arm.botId, query: "warm up the index", limit: 1, semantic: arm.config.codeSearchMode !== "keyword" }, 180000);
    if (arm.config.codeSearchMode === "keyword" || (r.semantic?.coverage || 0) >= 1) break;
    await sleep(3000);
  }
  indexTimes[arm.id] = (Date.now() - t0) / 1000;
  console.log(`index for ${arm.id}: ${indexTimes[arm.id].toFixed(1)}s`);
}
console.log(`\nmodel ${MODEL} · ${tasks.length} tasks × ${ARMS.length} arms × ${REPEATS} repeats = ${tasks.length * ARMS.length * REPEATS} runs\n`);

const promptFor = task => task.kind === "edit"
  ? `Make this change in your worktree, then confirm what you changed. Investigate with your tools first.\n\nTask: ${task.question}`
  : `Answer this question about the code in your worktree. Do not modify any files. Investigate with your tools, then give a short answer that names the exact files and functions.\n\nQuestion: ${task.question}`;

const results = [];
let n = 0;
for (let rep = 1; rep <= REPEATS; rep++) {
  for (const [ti, task] of tasks.entries()) {
    const order = ARMS.map((_, i) => ARMS[(i + ti + rep) % ARMS.length]);
    for (const arm of order) {
      n++;
      resetWorktree(arm);
      const threadId = `ab_${task.id}_${arm.id}_${rep}_${Date.now()}`;
      const started = Date.now();
      await api("POST", "/api/sessions/turn", { threadId, botId: arm.botId, botName: arm.id, prompt: promptFor(task), maxSteps: MAX_STEPS, disabledTools: arm.disabledTools });
      let turn = null;
      while (Date.now() - started < 20 * 60 * 1000) {
        await sleep(3000);
        turn = (await api("GET", `/api/sessions/status?threadId=${encodeURIComponent(threadId)}`)).turn;
        if (turn && turn.status !== "running") break;
      }
      const answer = String(turn?.finalContent || "");
      let solved;
      let detail = "";
      if (task.kind === "edit") {
        const v = task.verify([worktreeOf(arm)]);
        solved = v.ok;
        detail = v.detail;
      } else {
        solved = task.check(answer);
      }
      const tools = {};
      for (const c of turn?.toolCalls || []) tools[c.name] = (tools[c.name] || 0) + 1;
      const row = {
        rep, task: task.id, kind: task.kind, arm: arm.id, status: turn?.status || "timeout", solved, detail,
        steps: turn?.step || 0, toolCalls: (turn?.toolCalls || []).length, tools,
        promptTokens: turn?.usage?.prompt || 0, completionTokens: turn?.usage?.completion || 0,
        toolOutputChars: turn?.usage?.toolOutputChars || 0, seconds: Math.round((Date.now() - started) / 1000),
        answer: answer.slice(0, 1200)
      };
      results.push(row);
      fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ model: MODEL, maxSteps: MAX_STEPS, repeats: REPEATS, indexTimes, results }, null, 2));
      console.log(`[${String(n).padStart(3)}] r${rep} ${task.id.padEnd(9)} ${arm.id.padEnd(6)} ${row.solved ? "✓" : "✗"} steps=${String(row.steps).padStart(2)} calls=${String(row.toolCalls).padStart(2)} tokens=${row.promptTokens + row.completionTokens} ${row.seconds}s`);
    }
  }
}

const lines = [];
const say = s => { lines.push(s); console.log(s); };
say(`\n# Agent A/B — ${MODEL}`);
say(`${tasks.length} tasks (${tasks.filter(t => t.kind === "edit").length} edits) × ${ARMS.length} arms × ${REPEATS} repeats · max ${MAX_STEPS} steps · index build: ${Object.entries(indexTimes).map(([a, s]) => `${a} ${s.toFixed(1)}s`).join(", ") || "n/a"}\n`);
say("| arm | solved | tokens / run (mean ± sd) | tool calls / run | seconds / run |");
say("|---|---|---|---|---|");
for (const arm of ARMS) {
  const rs = results.filter(r => r.arm === arm.id);
  const tok = rs.map(r => r.promptTokens + r.completionTokens);
  const ok = rs.filter(r => r.solved).length;
  say(`| ${arm.id} | ${ok}/${rs.length} (${Math.round(100 * ok / rs.length)}%) | ${Math.round(mean(tok))} ± ${Math.round(sd(tok))} | ${mean(rs.map(r => r.toolCalls)).toFixed(1)} | ${Math.round(mean(rs.map(r => r.seconds)))} |`);
}
say(`\n| task | ${ARMS.map(a => a.id).join(" | ")} |`);
say(`|---|${ARMS.map(() => "---").join("|")}|`);
for (const task of tasks) {
  say(`| ${task.id}${task.kind === "edit" ? " (edit)" : ""} | ${ARMS.map(a => {
    const rs = results.filter(r => r.task === task.id && r.arm === a.id);
    return `${rs.filter(r => r.solved).length}/${rs.length}`;
  }).join(" | ")} |`);
}
fs.writeFileSync(path.join(outDir, "report.md"), `${lines.join("\n")}\n`);
console.log(`\nreport: ${path.join(outDir, "report.md")}\nresults: ${path.join(outDir, "results.json")}`);
cleanup();

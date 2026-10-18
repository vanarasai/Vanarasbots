// Shared by the bench harnesses: an isolated Vanaras (a throwaway clone of this repository with its own
// server, state and worktrees), local-model agents, and running one task through the real session runner.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const OLLAMA = "http://127.0.0.1:11434/v1";
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const mean = xs => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
export const sd = xs => (xs.length < 2 ? 0 : Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1)));

export function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on("error", reject);
});

// Two clones of this repository (with uncommitted ui/ and tests/ edits): one runs its own Vanaras, the other is
// the agents' project (the tasks are about this code, and a server refuses its own source as a project).
// Nothing touches the user's workspace.
function snapshotClone(dest) {
  execFileSync("git", ["clone", "--local", "--quiet", ROOT, dest]);
  for (const line of execFileSync("git", ["status", "--porcelain"], { cwd: ROOT }).toString().split("\n")) {
    if (!line.trim()) continue;
    const rel = line.slice(3).trim().replace(/^.* -> /, "");
    const src = path.join(ROOT, rel);
    if (!/^(?:ui|tests)\//.test(rel) || !fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(dest, rel));
  }
  execFileSync("git", ["add", "-A"], { cwd: dest });
  try { execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@local", "commit", "-qm", "bench snapshot"], { cwd: dest }); } catch {}
}

export async function startIsolatedVanaras({ prefix = "vanaras-bench-" } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const app = path.join(base, "app");
  const repo = path.join(base, "repo");
  snapshotClone(app);
  snapshotClone(repo);

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(app, "ui", "server.mjs")], {
    cwd: app,
    env: { ...process.env, VANARAS_PORT: String(port), VANARAS_STATE_DIR: path.join(base, "state"), VANARAS_WORKTREES_DIR: path.join(base, "worktrees") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  // The server's output is kept so a crash mid-run can be diagnosed.
  const logPath = path.join(base, "server.log");
  const log = fs.createWriteStream(logPath);
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  let exited = null;
  server.on("exit", (code, signal) => { exited = { code, signal }; });
  const cleanup = () => { try { server.kill("SIGTERM"); } catch {} };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  // A reused keep-alive socket can be reset just as the server closes it while idle; retry those. Repeating a
  // turn request is safe too: a new turn on the same thread supersedes the old one.
  async function api(method, p, body, timeoutMs = 60000) {
    for (let attempt = 1; ; attempt++) {
      if (exited) throw serverDied();
      try {
        const res = await fetch(`${url}${p}`, {
          method,
          headers: { "Content-Type": "application/json", "X-Vanaras-Project": encodeURIComponent(repo) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs)
        });
        return await res.json();
      } catch (err) {
        await sleep(500);
        if (exited) throw serverDied();
        const code = err.cause?.code || err.code;
        if (attempt >= 4 || !["ECONNRESET", "UND_ERR_SOCKET", "EPIPE"].includes(code)) throw err;
      }
    }
  }
  function serverDied() {
    const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").split("\n").slice(-30).join("\n") : "";
    return new Error(`bench server exited (code ${exited.code}, signal ${exited.signal}); log ${logPath}:\n${tail}`);
  }
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${url}/api/health`)).ok) break; } catch {}
    await sleep(250);
  }
  return { base, repo, url, api, cleanup, logPath };
}

// A local-model agent with a worktree of the clone. `config` adds agent settings (e.g. codeSearchMode).
export async function prepareAgent(env, { botId, name, model, config = {} }) {
  await env.api("POST", "/api/agent/skill", { botId, botName: name, action: "set", skillMarkdown: "", agentConfig: { provider: "local", baseUrl: OLLAMA, model, permissionPolicy: "auto", ...config } });
  const wt = await env.api("POST", "/api/agent/worktree", { botId, botName: name, action: "ensure" });
  if (!wt.worktreePath) throw new Error(`could not create a worktree for ${name}: ${JSON.stringify(wt)}`);
  return wt.worktreePath;
}

// Builds the agent's search index before timed runs (a one-time cost); returns seconds taken.
export async function warmIndex(env, botId, { semantic = true } = {}) {
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) {
    const r = await env.api("POST", "/api/code-search", { botId, query: "warm up the index", limit: 1, semantic }, 180000);
    if (!semantic || (r.semantic?.coverage || 0) >= 1) break;
    await sleep(3000);
  }
  return (Date.now() - t0) / 1000;
}

// Each run starts from the snapshot, so one run's edits (and index entries) never leak into the next.
export function resetWorktree(worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) return;
  execFileSync("git", ["reset", "--hard", "-q", "HEAD"], { cwd: worktreePath });
  execFileSync("git", ["clean", "-fdq"], { cwd: worktreePath });
}

export function promptFor(task) {
  return task.kind === "edit"
    ? `Make this change in your worktree, then confirm what you changed. Investigate with your tools first.\n\nTask: ${task.question}`
    : `Answer this question about the code in your worktree. Do not modify any files. Investigate with your tools, then give a short answer that names the exact files and functions.\n\nQuestion: ${task.question}`;
}

function toolTarget(args) {
  let a = args;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { return a.slice(0, 80); } }
  a = a || {};
  return String(a.command ?? a.filePath ?? a.path ?? a.pattern ?? a.query ?? JSON.stringify(a)).slice(0, 80);
}

// Runs one task through the real session runner and checks it (answer check, or verifier for edits).
export async function runTask(env, { task, botId, name, worktreePath, maxSteps = 15, disabledTools = [], extraGuidance = "", tag = "" }) {
  resetWorktree(worktreePath);
  const threadId = `bench_${task.id}_${tag || name}_${Date.now()}`;
  const started = Date.now();
  await env.api("POST", "/api/sessions/turn", { threadId, botId, botName: name, prompt: promptFor(task), maxSteps, disabledTools, extraGuidance });
  let turn = null;
  while (Date.now() - started < 20 * 60 * 1000) {
    await sleep(3000);
    turn = (await env.api("GET", `/api/sessions/status?threadId=${encodeURIComponent(threadId)}`)).turn;
    if (turn && turn.status !== "running") break;
  }
  const answer = String(turn?.finalContent || "");
  let solved;
  let detail = "";
  if (task.kind === "edit") {
    const v = task.verify([worktreePath]);
    solved = v.ok;
    detail = v.detail;
  } else {
    solved = task.check(answer);
  }
  const tools = {};
  for (const c of turn?.toolCalls || []) tools[c.name] = (tools[c.name] || 0) + 1;
  return {
    task: task.id,
    kind: task.kind,
    status: turn?.status || "timeout",
    solved,
    detail,
    steps: turn?.step || 0,
    toolCalls: (turn?.toolCalls || []).length,
    tools,
    toolTrail: (turn?.toolCalls || []).map(c => `${c.name}: ${toolTarget(c.args)}`),
    promptTokens: turn?.usage?.prompt || 0,
    completionTokens: turn?.usage?.completion || 0,
    toolOutputChars: turn?.usage?.toolOutputChars || 0,
    seconds: Math.round((Date.now() - started) / 1000),
    answer: answer.slice(0, 1200)
  };
}

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
import fs from "node:fs";
import path from "node:path";
import { TASKS } from "./agent-tasks.mjs";
import { mean, option, prepareAgent, runTask, sd, startIsolatedVanaras, warmIndex } from "./lib.mjs";

const MODEL = option("model", "qwen3:14b");
const MAX_STEPS = Number(option("steps", 15));
const REPEATS = Math.max(1, Number(option("repeats", 2)));

// grep: no index. bm25: code_search over the keyword index only (XERJ-style). hybrid: BM25 + EmbeddingGemma 2.
const ALL_ARMS = [
  { id: "grep", botId: "bot_ab_grep", disabledTools: ["code_search"], config: {} },
  { id: "bm25", botId: "bot_ab_bm25", disabledTools: [], config: { codeSearchMode: "keyword" } },
  { id: "hybrid", botId: "bot_ab_hybrid", disabledTools: [], config: { codeSearchMode: "hybrid" } }
];
const armFilter = option("arms", "").split(",").filter(Boolean);
const ARMS = armFilter.length ? ALL_ARMS.filter(a => armFilter.includes(a.id)) : ALL_ARMS;
const taskFilter = option("tasks", "").split(",").filter(Boolean);
const tasks = taskFilter.length ? TASKS.filter(t => taskFilter.includes(t.id)) : TASKS;
if (!ARMS.length || !tasks.length) throw new Error("no arms or tasks selected");

const env = await startIsolatedVanaras({ prefix: "vanaras-ab-" });
const outDir = path.resolve(option("out", env.base));
fs.mkdirSync(outDir, { recursive: true });

const worktrees = {};
for (const arm of ARMS) worktrees[arm.id] = await prepareAgent(env, { botId: arm.botId, name: arm.id, model: MODEL, config: arm.config });
// Indexes are a one-time cost per worktree; build them before the timed runs and report them separately.
const indexTimes = {};
for (const arm of ARMS.filter(a => a.id !== "grep")) {
  indexTimes[arm.id] = await warmIndex(env, arm.botId, { semantic: arm.config.codeSearchMode !== "keyword" });
  console.log(`index for ${arm.id}: ${indexTimes[arm.id].toFixed(1)}s`);
}
console.log(`\nmodel ${MODEL} · ${tasks.length} tasks × ${ARMS.length} arms × ${REPEATS} repeats = ${tasks.length * ARMS.length * REPEATS} runs\n`);

const results = [];
let n = 0;
for (let rep = 1; rep <= REPEATS; rep++) {
  for (const [ti, task] of tasks.entries()) {
    const order = ARMS.map((_, i) => ARMS[(i + ti + rep) % ARMS.length]);
    for (const arm of order) {
      n++;
      const run = await runTask(env, { task, botId: arm.botId, name: arm.id, worktreePath: worktrees[arm.id], maxSteps: MAX_STEPS, disabledTools: arm.disabledTools, tag: `${arm.id}_${rep}` });
      const row = { rep, arm: arm.id, ...run };
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
env.cleanup();

#!/usr/bin/env node
// Harness refine step (propose → probe → compose, after google-research/harness2): searches for extra agent
// guidance that solves more benchmark tasks for fewer tokens, using only local models.
//
//   node tests/bench/harness-refine.mjs [--model qwen3:14b] [--proposer qwen3:14b] [--tasks retry,vote]
//                                       [--candidates 3] [--repeats 1] [--steps 15] [--start file] [--out dir]
//
// 1. Probe: run the tasks with the current guidance (none, or --start) through the real session runner.
// 2. Propose: the proposer model reads the runs (outcome, tool trail, answer) and writes K guidance variants.
// 3. Probe each variant on the same tasks.
// 4. Compose the two best variants into one and probe it.
// The best variant is kept only if it beats the baseline (more solved, or as many for ≥10% fewer tokens).
// Writes results.json, report.md and best-guidance.json. Nothing is applied to live agents: to use the
// guidance, add it to an agent's skill yourself after reading the report.
import fs from "node:fs";
import path from "node:path";
import { TASKS } from "./agent-tasks.mjs";
import { option, prepareAgent, runTask, startIsolatedVanaras, warmIndex } from "./lib.mjs";
import { beatsBaseline, composePrompt, describeRun, parseCandidates, proposePrompt, rank, summarize } from "./refine-core.mjs";

const MODEL = option("model", "qwen3:14b");
const PROPOSER = option("proposer", MODEL);
const K = Math.max(1, Number(option("candidates", 3)));
const REPEATS = Math.max(1, Number(option("repeats", 1)));
const MAX_STEPS = Number(option("steps", 15));
const startFile = option("start", "");
const START = startFile ? fs.readFileSync(startFile, "utf8").trim() : "";
const taskFilter = option("tasks", "").split(",").filter(Boolean);
const tasks = taskFilter.length ? TASKS.filter(t => taskFilter.includes(t.id)) : TASKS;
if (!tasks.length) throw new Error("no tasks selected");

async function askProposer(prompt) {
  const res = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: PROPOSER, stream: false, think: false, messages: [{ role: "user", content: prompt }], options: { temperature: 0.8, num_ctx: 16384 } }),
    signal: AbortSignal.timeout(10 * 60 * 1000)
  });
  if (!res.ok) throw new Error(`proposer ${PROPOSER}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).message?.content || "";
}

const env = await startIsolatedVanaras({ prefix: "vanaras-refine-" });
const outDir = path.resolve(option("out", env.base));
fs.mkdirSync(outDir, { recursive: true });
const botId = "bot_refine";
const worktreePath = await prepareAgent(env, { botId, name: "refine", model: MODEL, config: { codeSearchMode: "hybrid" } });
console.log(`index: ${(await warmIndex(env, botId)).toFixed(1)}s`);
console.log(`agent ${MODEL} · proposer ${PROPOSER} · ${tasks.length} tasks × ${REPEATS} repeats per variant · up to ${K + 2} variants\n`);

const variants = [];
const save = extra => fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ model: MODEL, proposer: PROPOSER, maxSteps: MAX_STEPS, repeats: REPEATS, tasks: tasks.map(t => t.id), variants, ...extra }, null, 2));

async function probe(label, guidance) {
  const runs = [];
  for (let rep = 1; rep <= REPEATS; rep++) {
    for (const task of tasks) {
      const run = await runTask(env, { task, botId, name: "refine", worktreePath, maxSteps: MAX_STEPS, extraGuidance: guidance, tag: `${label}_${rep}` });
      runs.push({ rep, ...run });
      console.log(`  ${label.padEnd(10)} r${rep} ${task.id.padEnd(9)} ${run.solved ? "✓" : "✗"} calls=${String(run.toolCalls).padStart(2)} tokens=${run.promptTokens + run.completionTokens} ${run.seconds}s`);
    }
  }
  const variant = { label, guidance, score: summarize(runs), runs };
  variants.push(variant);
  save();
  console.log(`  → ${label}: ${variant.score.solved}/${variant.score.runs} solved, ${variant.score.meanTokens} tokens/run\n`);
  return variant;
}

console.log("probe: baseline");
const baseline = await probe("baseline", START);

console.log("propose");
const taskById = Object.fromEntries(tasks.map(t => [t.id, t]));
const proposal = await askProposer(proposePrompt({ current: START, runs: baseline.runs.map(r => describeRun(taskById[r.task], r)), k: K }));
const candidates = parseCandidates(proposal, K);
console.log(`  ${candidates.length} candidates\n`);
for (const [i, guidance] of candidates.entries()) {
  console.log(`probe: candidate ${i + 1}\n  "${guidance.replace(/\s+/g, " ").slice(0, 160)}…"`);
  await probe(`cand${i + 1}`, guidance);
}

const proposed = rank(variants.filter(v => v.label.startsWith("cand")));
if (proposed.length >= 2) {
  const [composed] = parseCandidates(await askProposer(composePrompt(proposed[0].guidance, proposed[1].guidance)), 1);
  if (composed) {
    console.log(`probe: composed (${proposed[0].label} + ${proposed[1].label})`);
    await probe("composed", composed);
  }
}

const best = rank(variants.filter(v => v !== baseline))[0];
const accepted = Boolean(best && beatsBaseline(best, baseline));
const winner = accepted ? best : baseline;
fs.writeFileSync(path.join(outDir, "best-guidance.json"), JSON.stringify({ accepted, label: winner.label, guidance: winner.guidance, score: winner.score, baseline: baseline.score, model: MODEL, tasks: tasks.map(t => t.id) }, null, 2));
save({ accepted, winner: winner.label, proposal });

const lines = [];
const say = s => { lines.push(s); console.log(s); };
say(`# Harness refine — ${MODEL}`);
say(`Proposer ${PROPOSER} · ${tasks.length} tasks (${tasks.map(t => t.id).join(", ")}) × ${REPEATS} repeats per variant · max ${MAX_STEPS} steps\n`);
say("| variant | solved | tokens / run | tool calls / run |");
say("|---|---|---|---|");
for (const v of variants) say(`| ${v.label}${v === winner ? " ★" : ""} | ${v.score.solved}/${v.score.runs} | ${v.score.meanTokens} | ${v.score.meanToolCalls} |`);
say(`\n| task | ${variants.map(v => v.label).join(" | ")} |`);
say(`|---|${variants.map(() => "---").join("|")}|`);
for (const task of tasks) {
  say(`| ${task.id} | ${variants.map(v => {
    const rs = v.runs.filter(r => r.task === task.id);
    return `${rs.filter(r => r.solved).length}/${rs.length}`;
  }).join(" | ")} |`);
}
say(accepted
  ? `\n**Kept ${winner.label}**: beats the baseline on these tasks. Confirm on other tasks or more repeats before adding it to an agent's skill.`
  : "\n**Kept the baseline**: no variant solved more, or as many for ≥10% fewer tokens.");
say("\n## Guidance tried\n");
for (const v of variants) say(`- **${v.label}**: ${v.guidance ? v.guidance.replace(/\s+/g, " ") : "(none)"}`);
fs.writeFileSync(path.join(outDir, "report.md"), `${lines.join("\n")}\n`);
console.log(`\nreport: ${path.join(outDir, "report.md")}\nbest: ${path.join(outDir, "best-guidance.json")}`);
env.cleanup();

// Pure parts of the harness refine step (tests/bench/harness-refine.mjs): the prompts sent to the proposer
// model, parsing its candidates, and scoring and choosing between guidance variants. No I/O here.

export const MAX_GUIDANCE_CHARS = 1200;

// Local reasoning models wrap output in <think> blocks and code fences; candidates are a JSON array of strings,
// or failing that one numbered/bulleted item per line.
export function parseCandidates(text, k) {
  const body = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  let items = [];
  const json = body.match(/\[[\s\S]*\]/);
  if (json) {
    try {
      const parsed = JSON.parse(json[0]);
      if (Array.isArray(parsed)) items = parsed.map(x => (typeof x === "string" ? x : x?.guidance)).filter(x => typeof x === "string");
    } catch {}
  }
  if (!items.length) {
    items = body.split("\n").map(l => l.match(/^\s*(?:\d+[.)]|[-*])\s+(.+)$/)?.[1]).filter(Boolean);
  }
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const g = raw.trim().slice(0, MAX_GUIDANCE_CHARS);
    const key = g.toLowerCase().replace(/\s+/g, " ");
    if (!g || seen.has(key)) continue;
    seen.add(key);
    out.push(g);
    if (out.length >= k) break;
  }
  return out;
}

export function summarize(runs) {
  const tokens = runs.map(r => (r.promptTokens || 0) + (r.completionTokens || 0));
  return {
    runs: runs.length,
    solved: runs.filter(r => r.solved).length,
    meanTokens: Math.round(tokens.reduce((s, x) => s + x, 0) / Math.max(1, runs.length)),
    meanToolCalls: Number((runs.reduce((s, r) => s + (r.toolCalls || 0), 0) / Math.max(1, runs.length)).toFixed(1))
  };
}

// More tasks solved wins; among equals, fewer tokens.
export function rank(variants) {
  return [...variants].sort((a, b) => b.score.solved - a.score.solved || a.score.meanTokens - b.score.meanTokens);
}

// A variant replaces the baseline only if it solves more, or solves as many for clearly fewer tokens. With a
// handful of runs anything smaller is noise, so ties go to the baseline (no extra guidance).
export function beatsBaseline(variant, baseline, { tokenMargin = 0.9 } = {}) {
  if (variant.score.solved !== baseline.score.solved) return variant.score.solved > baseline.score.solved;
  return variant.score.meanTokens <= baseline.score.meanTokens * tokenMargin;
}

// What the proposer sees about a run: the task, the outcome, the tools used and the answer's opening.
export function describeRun(task, run) {
  const trail = (run.toolTrail || []).slice(0, 12).map(t => `    - ${t}`).join("\n") || "    (no tool calls)";
  const outcome = run.solved ? "SOLVED" : run.kind === "edit" ? `FAILED (${run.detail || "verifier failed"})` : "FAILED (answer missed the expected code)";
  return [
    `Task ${task.id} (${task.kind}): ${task.question}`,
    `  Outcome: ${outcome}; ${run.steps} steps, ${run.toolCalls} tool calls, ${(run.promptTokens || 0) + (run.completionTokens || 0)} tokens, status ${run.status}`,
    `  Tools:\n${trail}`,
    `  Answer (start): ${String(run.answer || "").replace(/\s+/g, " ").slice(0, 400) || "(empty)"}`
  ].join("\n");
}

export function proposePrompt({ current, runs, k }) {
  return [
    "You improve the instructions given to a coding agent. The agent answers questions about a codebase and makes",
    "small edits, using tools such as code_search, fs_read, fs_list and shell_exec, in a loop with a step limit.",
    "",
    current ? `Its current extra guidance:\n${current}` : "It currently has no extra guidance.",
    "",
    "Results on the probe tasks:",
    runs.join("\n\n"),
    "",
    `Propose ${k} different replacements for the extra guidance that would make the agent solve more of these`,
    "tasks with fewer tokens. Address the failure patterns you see (for example stopping before reading the code,",
    "answering without naming files and functions, searching too broadly, running out of steps), not the specific",
    "answers: never mention these tasks' file names, function names or answers. Each candidate is at most 6 short",
    "imperative sentences. Make the candidates differ in approach.",
    "",
    'Reply with only a JSON array of strings, e.g. ["...", "..."].'
  ].join("\n");
}

export function composePrompt(a, b) {
  return [
    "Two sets of instructions for a coding agent each helped on a benchmark. Merge them into one set that keeps the",
    "strongest, non-overlapping instructions of both, at most 6 short imperative sentences.",
    "",
    `A:\n${a}`,
    "",
    `B:\n${b}`,
    "",
    'Reply with only a JSON array holding the one merged string, e.g. ["..."].'
  ].join("\n");
}

import assert from "node:assert/strict";
import test from "node:test";
import { beatsBaseline, describeRun, parseCandidates, rank, summarize } from "../bench/refine-core.mjs";

test("parseCandidates reads a JSON array after a think block and inside a code fence", () => {
  const text = '<think>let me see ["not this"]</think>\n```json\n["Read the file before answering.", "Name files and functions."]\n```';
  assert.deepEqual(parseCandidates(text, 3), ["Read the file before answering.", "Name files and functions."]);
});

test("parseCandidates falls back to numbered or bulleted lines, dedupes, and caps at k", () => {
  const text = "Here you go:\n1. Search first.\n2) search   first.\n- Read the match.\n* Answer briefly.";
  assert.deepEqual(parseCandidates(text, 2), ["Search first.", "Read the match."]);
});

test("parseCandidates accepts objects with a guidance field and returns [] for nothing usable", () => {
  assert.deepEqual(parseCandidates('[{"guidance": "Verify edits."}]', 3), ["Verify edits."]);
  assert.deepEqual(parseCandidates("no list here", 3), []);
});

test("summarize, rank and beatsBaseline: solved first, then tokens; ties keep the baseline", () => {
  const runs = (solved, tokens) => solved.map((s, i) => ({ solved: s, promptTokens: tokens[i], completionTokens: 0, toolCalls: 2 }));
  const base = { label: "baseline", score: summarize(runs([true, false], [1000, 1000])) };
  const more = { label: "a", score: summarize(runs([true, true], [3000, 3000])) };
  const cheaper = { label: "b", score: summarize(runs([true, false], [800, 800])) };
  const slightly = { label: "c", score: summarize(runs([false, true], [950, 950])) };
  assert.deepEqual(base.score, { runs: 2, solved: 1, meanTokens: 1000, meanToolCalls: 2 });
  assert.deepEqual(rank([slightly, cheaper, more]).map(v => v.label), ["a", "b", "c"]);
  assert.equal(beatsBaseline(more, base), true);
  assert.equal(beatsBaseline(cheaper, base), true);
  assert.equal(beatsBaseline(slightly, base), false);
});

test("describeRun shows outcome, tool trail and answer start", () => {
  const text = describeRun({ id: "t1", kind: "edit", question: "Add X" }, { solved: false, kind: "edit", detail: "test failed", steps: 3, toolCalls: 1, promptTokens: 10, completionTokens: 5, status: "done", toolTrail: ["fs_read: a.mjs"], answer: "Done." });
  assert.match(text, /FAILED \(test failed\)/);
  assert.match(text, /- fs_read: a\.mjs/);
  assert.match(text, /15 tokens/);
});

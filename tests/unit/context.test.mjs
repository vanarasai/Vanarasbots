import "./_env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { compactMessagesList, splitReasoningAndVisibleOutput } from "../../ui/src/context.mjs";

const msgs = (n) => [
  { role: "system", content: "SYSTEM PROMPT" },
  ...Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }))
];

test("compaction: short conversations are left untouched", () => {
  const input = msgs(4);
  const out = compactMessagesList(input, 4);
  assert.equal(out.compacted, false);
  assert.equal(out.messages, input, "the very same array is returned when nothing is compacted");
});

test("compaction: keeps the system prompt, summarises the middle, preserves the most recent turns", () => {
  const input = msgs(20);
  const out = compactMessagesList(input, 4);
  assert.equal(out.compacted, true);
  assert.equal(out.compactedTurnsCount, 16);
  assert.equal(out.messages.length, 1 + 1 + 4, "system + summary + 4 recent");
  assert.equal(out.messages[0].content, "SYSTEM PROMPT");
  assert.match(out.messages[1].content, /CONTEXT COMPACTION SUMMARY/);
  assert.deepEqual(out.messages.slice(-4).map(m => m.content), ["m16", "m17", "m18", "m19"]);
});

test("compaction: the summary retains the user's original goals and the tools that ran", () => {
  const input = [
    { role: "system", content: "S" },
    { role: "user", content: "Build a podcast generator" },
    { role: "assistant", content: "[TOOL: fs_write | a.py]" },
    { role: "assistant", content: "[TOOL: shell_exec | python3 a.py]" },
    ...Array.from({ length: 8 }, (_, i) => ({ role: "user", content: `later ${i}` }))
  ];
  const out = compactMessagesList(input, 2);
  assert.equal(out.compacted, true);
  assert.match(out.summary, /Build a podcast generator/);
  assert.match(out.summary, /\[TOOL: fs_write/);
  assert.match(out.summary, /\[TOOL: shell_exec/);
});

test("compaction: works without a system message", () => {
  const input = msgs(20).slice(1);
  const out = compactMessagesList(input, 3);
  assert.equal(out.compacted, true);
  assert.match(out.messages[0].content, /CONTEXT COMPACTION SUMMARY/);
  assert.equal(out.messages.length, 1 + 3);
});

test("compaction: non-array input is returned as-is", () => {
  assert.equal(compactMessagesList(null).compacted, false);
  assert.equal(compactMessagesList(undefined).compacted, false);
});

test("reasoning split: closed <think> blocks are moved out of the visible reply", () => {
  const r = splitReasoningAndVisibleOutput("<think>plan the work</think>Here is the answer.");
  assert.equal(r.cleanedOutput, "Here is the answer.");
  assert.equal(r.reasoning, "plan the work");
});

test("reasoning split: an unclosed <think> tail is treated as reasoning, not shown to the user", () => {
  const r = splitReasoningAndVisibleOutput("Visible text<think>still thinking and never closed");
  assert.equal(r.cleanedOutput, "Visible text");
  assert.match(r.reasoning, /still thinking/);
});

test("reasoning split: [THOUGHT: ...] markers and prior provider reasoning are merged", () => {
  const r = splitReasoningAndVisibleOutput("Answer [THOUGHT: inline note]", "provider reasoning");
  assert.equal(r.cleanedOutput, "Answer");
  assert.match(r.reasoning, /provider reasoning/);
  assert.match(r.reasoning, /inline note/);
  assert.equal(r.thoughts.length, 2);
});

test("reasoning split: plain text passes through unchanged", () => {
  const r = splitReasoningAndVisibleOutput("Just an answer.");
  assert.deepEqual(r, { thoughts: [], reasoning: "", cleanedOutput: "Just an answer." });
});

test("reasoning split: a reply swallowed by reasoning is recovered at the response boundary", () => {
  const raw = "<think>I should write the file.\n===FILE: a.py===\nprint(1)\n===END_FILE===";
  const r = splitReasoningAndVisibleOutput(raw);
  assert.match(r.cleanedOutput, /===FILE: a\.py===/);
  assert.doesNotMatch(r.reasoning, /===FILE:/);
});

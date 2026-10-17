import "./_env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { compactMessagesList, detectUnfulfilledAction, splitReasoningAndVisibleOutput, threadMessagesToChat } from "../../ui/src/context.mjs";

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

test("thread history: UI-shaped messages reach the model with their text and the right roles", () => {
  const chat = threadMessagesToChat([
    { senderType: "user", text: "run diagnostics" },
    { senderType: "bot", botId: "bot_r1", text: "Checking the WAV files." },
    { senderType: "terminal", command: "ls output", exitCode: 0, text: "episode.wav" },
    { senderType: "bot", botId: "bot_r2", text: "The TTS model is missing." },
    { role: "assistant", botId: "bot_r1", content: "Server-written reply" },
    { senderType: "user", text: "   " }
  ], "bot_r1", { bot_r2: "R2" });
  assert.deepEqual(chat, [
    { role: "user", content: "run diagnostics" },
    { role: "assistant", content: "Checking the WAV files." },
    { role: "user", content: "[Terminal: `ls output` exited 0]\nepisode.wav" },
    { role: "user", content: "[@R2 said]\nThe TTS model is missing." },
    { role: "assistant", content: "Server-written reply" }
  ]);
});

test("unfulfilled action: announced-but-not-run work and unparsed tool tags are detected; answers are not", () => {
  assert.match(detectUnfulfilledAction("Running full audio diagnostics now:"), /did not call any tool/);
  assert.match(detectUnfulfilledAction("Found the bug.\nLet me fix it"), /did not call any tool/);
  assert.match(detectUnfulfilledAction("[TOOL: shell | echo \"[\" broken"), /could not be parsed/);
  assert.equal(detectUnfulfilledAction("All 12 tests pass; the WAV is 24 kHz speech."), null);
  assert.equal(detectUnfulfilledAction("Should I regenerate the episode?"), null);
  assert.match(detectUnfulfilledAction("Most likely causes: missing model, wrong sample rate.\nShould I proceed?"), /need no permission/);
  assert.match(detectUnfulfilledAction("Want me to run the full diagnostics?"), /need no permission/);
  assert.equal(detectUnfulfilledAction("Should I delete the old output folder?"), null);
  assert.equal(detectUnfulfilledAction("Should I push this branch?"), null);
  assert.equal(detectUnfulfilledAction("Can I check with Kokoro or switch to Piper?"), null);
  assert.equal(detectUnfulfilledAction(""), null);
});

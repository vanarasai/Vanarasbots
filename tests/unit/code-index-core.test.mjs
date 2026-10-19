import "./_env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Bm25Index, bestSnippet, chunkFile, demoteTests, formatResults, fuseRankings, isTestPath, normalizeVector, queryWantsTests, stem, tokenize, vectorSearch } from "../../ui/src/code-index-core.mjs";

test("tokenize: identifiers match whole and by their parts; stopwords drop", () => {
  const t = tokenize("Where do we call parsePersonaList and MAX_PANELISTS?");
  for (const want of ["parsepersonalist", "parse", "persona", "list", "max_panelists", "panelists", "call"]) assert.ok(t.includes(stem(want)), want);
  assert.deepEqual(tokenize("processes created counting status"), tokenize("process create count status"));
  for (const stop of ["where", "do", "we", "and"]) assert.ok(!t.includes(stop), stop);
});

test("chunking: a file splits at declarations, keeps line numbers, and merges tiny preambles", () => {
  const src = [
    "import fs from 'node:fs';",
    "",
    "export function alpha(a) {",
    "  return a + 1;",
    "}",
    "",
    "async function beta() {",
    "  return 2;",
    "}",
    "",
    "class Gamma {",
    "  run() {}",
    "}"
  ].join("\n");
  const chunks = chunkFile("ui/x.mjs", src);
  assert.deepEqual(chunks.map(c => [c.start, c.end, c.symbol]), [[1, 6, "alpha"], [7, 10, "beta"], [11, 13, "Gamma"]]);
});

test("chunking: functions inside an HTML <script>, all at the same indentation, still split", () => {
  const src = ["<script>", "    function one() {", "      return 1;", "    }", "", "    async function two() {", "      return 2;", "    }", "</script>"].join("\n");
  const chunks = chunkFile("ui/index.html", src);
  assert.deepEqual(chunks.map(c => c.symbol), ["one", "two"]);
  assert.equal(chunks[1].text.split("\n")[0], "    async function two() {");
});

test("chunking: the comment block above a declaration belongs to that declaration", () => {
  const src = ["function first() {", "  return 1;", "}", "", "// Retries overloaded providers", "// with backoff.", "export async function retry() {", "  return 2;", "}"].join("\n");
  const chunks = chunkFile("r.mjs", src);
  assert.deepEqual(chunks.map(c => [c.start, c.symbol]), [[1, "first"], [5, "retry"]]);
});

test("chunking: a helper declared inside a JS function does not split it", () => {
  const src = ["export async function outer() {", "  const wait = (ms) => new Promise(r => setTimeout(r, ms));", "  await wait(1);", "  return 3;", "}", "", "function next() {", "  return 4;", "}"].join("\n");
  assert.deepEqual(chunkFile("o.mjs", src).map(c => [c.start, c.end, c.symbol]), [[1, 6, "outer"], [7, 9, "next"]]);
});

test("chunking: long units are windowed with overlap; plain text without declarations is windowed", () => {
  const body = ["def big():", ...Array.from({ length: 200 }, (_, i) => `    x = ${i}`)].join("\n");
  const chunks = chunkFile("a.py", body);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every(c => c.end - c.start + 1 <= 80));
  assert.equal(chunks[1].start, 71, "windows overlap by 10 lines");
  assert.ok(chunkFile("notes.txt", Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n")).length >= 2);
});

test("bm25: chunks naming the symbol match and unrelated ones do not; the declared name (weighted as the index does) ranks the definition first", () => {
  const raw = [
    "function tallyVotes(answers, options) { counts votes }",
    "function renderThreadList() { draws the sidebar }",
    "const tally = tallyVotes(latest, run.options); summary of votes"
  ];
  const plain = new Bm25Index(raw).search("where are votes tallied tallyVotes");
  assert.deepEqual(new Set(plain.map(r => r.id)), new Set([0, 2]));
  // code-index.mjs indexes `${path} ${symbol}×3 ${text}`, so the declaration outranks a call site.
  const symbols = ["tallyVotes", "renderThreadList", ""];
  const weighted = new Bm25Index(raw.map((t, i) => `${symbols[i]} ${symbols[i]} ${symbols[i]} ${t}`)).search("tallyVotes");
  assert.equal(weighted[0].id, 0);
});

test("vectors: truncation then normalisation gives cosine ranking", () => {
  const q = normalizeVector([1, 0, 0, 9], 3);
  assert.equal(q.length, 3);
  const vecs = [normalizeVector([0, 1, 0], 3), normalizeVector([0.9, 0.1, 0], 3), null];
  assert.deepEqual(vectorSearch(q, vecs).map(r => r.id), [1, 0]);
});

test("fusion: an item found by both lists beats items found by one", () => {
  const fused = fuseRankings([
    { name: "keyword", results: [{ id: 5 }, { id: 2 }] },
    { name: "semantic", results: [{ id: 9 }, { id: 2 }] }
  ]);
  assert.equal(fused[0].id, 2);
  assert.deepEqual(fused[0].via, ["keyword", "semantic"]);
});

test("snippets and formatting: the matching window is kept, lines are numbered, and the budget holds", () => {
  const text = Array.from({ length: 100 }, (_, i) => (i === 70 ? "const answer = retryOverload();" : `filler ${i}`)).join("\n");
  const snip = bestSnippet({ start: 10, end: 109, text }, "retryOverload", 20);
  assert.ok(snip.start <= 80 && snip.end >= 80, `window ${snip.start}-${snip.end} must contain line 80`);
  const many = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.js`, start: 1, end: 40, symbol: "s", via: ["keyword"], text: "x".repeat(2000) }));
  const out = formatResults(many, { budgetChars: 5000 });
  assert.ok(out.shown >= 1 && out.shown < 10);
  assert.match(out.text, /── f0\.js:1-40 \(s\) \[keyword\]\n {4}1 {2}x/);
});

test("test files: recognised by folder and name, ranked below equal source matches unless the query asks about tests", () => {
  for (const p of ["tests/tier5-platform.test.mjs", "tests/unit/x.mjs", "src/__tests__/a.js", "pkg/foo_test.go", "test_podcast.py", "ui/a.spec.ts"]) assert.ok(isTestPath(p), p);
  for (const p of ["ui/src/agent-tools.mjs", "latest.mjs", "contest/rules.md", "attestation.py"]) assert.ok(!isTestPath(p), p);
  const chunks = [{ path: "tests/tier5-platform.test.mjs" }, { path: "ui/src/agent-tools.mjs" }];
  const fused = [{ id: 0, score: 0.032, via: ["keyword"] }, { id: 1, score: 0.030, via: ["keyword"] }];
  assert.deepEqual(demoteTests(fused, chunks, "how long does the agent wait for approval").map(f => f.id), [1, 0]);
  assert.ok(queryWantsTests("which test covers approvals"));
  assert.deepEqual(demoteTests(fused, chunks, "which test covers approvals").map(f => f.id), [0, 1]);
});

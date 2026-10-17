#!/usr/bin/env node
// Retrieval benchmark on this repository: for questions whose answer location is known, compare what an
// agent gets from grep, from keyword search, and from hybrid (keyword + EmbeddingGemma 2) search.
// Measures whether the answer is found (and at what rank) and how many characters the agent must read.
// No paid model calls. Usage: node tests/bench/code-search-bench.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
process.env.VANARAS_STATE_DIR = process.env.VANARAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "vanaras-bench-"));
const { codeSearch, refreshIndex } = await import(path.join(ROOT, "ui/src/code-index.mjs"));

// grep: the keyword an agent would plausibly try first for that question.
const CASES = [
  { q: "where do we retry when the provider is overloaded", file: "ui/src/session-runner.mjs", symbol: "queryModelWithRetry", grep: "retry" },
  { q: "how are A/B votes counted", file: "ui/src/panel-core.mjs", symbol: "tallyVotes", grep: "vote" },
  { q: "which model does an agent or a panel use", file: "ui/src/session-runner.mjs", symbol: "resolveAgentModel", grep: "model" },
  { q: "where are API keys saved to disk", file: "ui/src/vault.mjs", symbol: "saveLocalKeysVault", grep: "apiKey" },
  { q: "which shell commands are blocked as destructive", file: "ui/src/security.mjs", symbol: "checkCommandPermission", grep: "rm -rf" },
  { q: "kill a process together with all its child processes", file: "ui/src/process.mjs", symbol: "killProcessTree", grep: "kill" },
  { q: "where are per-agent git worktrees created", file: "ui/src/worktree.mjs", symbol: "ensureAgentWorktree", grep: "worktree add" },
  { q: "agent says it will run something but emits no tool call", file: "ui/src/context.mjs", symbol: "detectUnfulfilledAction", grep: "tool call" },
  { q: "redirect the web preview to the agent's own server", file: "ui/src/routes/files.mjs", symbol: "handleFilesRoutes", grep: "web-preview" },
  { q: "parse the persona list the model returns", file: "ui/src/panel-core.mjs", symbol: "parsePersonaList", grep: "persona" },
  { q: "split code files into chunks at function boundaries", file: "ui/src/code-index-core.mjs", symbol: "chunkFile", grep: "chunk" },
  { q: "loopback only check of Host and Origin headers", file: "ui/src/security.mjs", symbol: "enforceLocalRequestBoundary", grep: "origin" }
];

function defLine(file, symbol) {
  const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
  const rx = new RegExp(`(?:function\\s*\\*?\\s*|class\\s+|(?:const|let|var)\\s+)${symbol}\\b`);
  const i = lines.findIndex(l => rx.test(l));
  if (i < 0) throw new Error(`${symbol} not found in ${file}`);
  return i + 1;
}

const GREP_TOOL_CAP = 6000;
function grepArm(c, line) {
  let out = "";
  try { out = execFileSync("git", ["grep", "-n", "-I", "-i", "-F", c.grep], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString(); } catch (e) { out = String(e.stdout || ""); }
  const hits = out.split("\n").filter(Boolean);
  // "found" only counts a hit inside what the grep tool actually hands the agent (its first GREP_TOOL_CAP chars).
  const visible = out.slice(0, GREP_TOOL_CAP).split("\n").filter(Boolean);
  const idx = visible.findIndex(h => {
    const m = /^(.*?):(\d+):/.exec(h);
    return m && m[1] === c.file && Number(m[2]) >= line && Number(m[2]) <= line + 60;
  });
  return { found: idx >= 0, rank: idx >= 0 ? idx + 1 : null, chars: Math.min(out.length, GREP_TOOL_CAP), raw: out.length, lines: hits.length };
}

async function searchArm(c, line, semantic) {
  const r = await codeSearch(ROOT, c.q, { limit: 8, semantic });
  const idx = r.results.findIndex(x => x.path === c.file && x.start <= line + 5 && x.end >= line);
  return { found: idx >= 0, rank: idx >= 0 ? idx + 1 : null, chars: r.text.length, semanticOn: r.semantic.enabled, reason: r.semantic.reason };
}

const t0 = Date.now();
await refreshIndex(ROOT, { embedBudgetMs: 600000 });
console.log(`Index ready in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const rows = [];
let hybridAvailable = true;
for (const c of CASES) {
  const line = defLine(c.file, c.symbol);
  const g = grepArm(c, line);
  const k = await searchArm(c, line, false);
  const h = await searchArm(c, line, true);
  if (!h.semanticOn) hybridAvailable = false;
  rows.push({ c, g, k, h });
}

const fmt = a => (a.found ? `#${a.rank}` : "miss");
console.log("question".padEnd(52), "grep (rank/chars shown)".padEnd(24), "keyword".padEnd(16), hybridAvailable ? "hybrid" : "hybrid (unavailable)");
for (const { c, g, k, h } of rows) {
  console.log(c.q.slice(0, 50).padEnd(52), `${fmt(g)} / ${g.chars}`.padEnd(24), `${fmt(k)} / ${k.chars}`.padEnd(16), hybridAvailable ? `${fmt(h)} / ${h.chars}` : "-");
}
const sum = (arm, f) => rows.reduce((s, r) => s + f(r[arm]), 0);
const n = rows.length;
const top3 = arm => rows.filter(r => r[arm].found && r[arm].rank <= 3).length;
console.log(`\nfound in top 3: grep ${top3("g")}/${n} · keyword ${top3("k")}/${n}${hybridAvailable ? ` · hybrid ${top3("h")}/${n}` : ""}`);
console.log(`found at all:   grep ${rows.filter(r => r.g.found).length}/${n} · keyword ${rows.filter(r => r.k.found).length}/${n}${hybridAvailable ? ` · hybrid ${rows.filter(r => r.h.found).length}/${n}` : ""}`);
console.log(`chars to read:  grep ${sum("g", a => a.chars)} shown (${sum("g", a => a.raw)} raw before the tool's ${GREP_TOOL_CAP}-char cap) · keyword ${sum("k", a => a.chars)}${hybridAvailable ? ` · hybrid ${sum("h", a => a.chars)}` : ""}`);
if (!hybridAvailable) console.log(`\nHybrid not measured: ${rows[0].h.reason}`);

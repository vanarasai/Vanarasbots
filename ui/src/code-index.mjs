// Per-folder hybrid search index (keyword BM25 + local EmbeddingGemma 2 vectors via Ollama), kept fresh by
// re-reading only files whose size/mtime changed and re-embedding only chunks whose content changed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.mjs";
import { Bm25Index, bestSnippet, chunkFile, demoteTests, formatResults, fuseRankings, normalizeVector, vectorSearch } from "./code-index-core.mjs";

export const INDEX_DIR = path.join(STATE_DIR, ".vanaras-index");
export const EMBED_MODEL = process.env.VANARAS_EMBED_MODEL || "embeddinggemma-2:270m-q8_0-text";
const OLLAMA_URL = (process.env.VANARAS_OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const EMBED_DIMS = 256;
const EMBED_BATCH = 16;
const EMBED_CHARS = 6000;
const MAX_FILE_BYTES = 400 * 1024;
const MAX_FILES = 6000;
const SKIP_DIRS = new Set([".git", "node_modules", "target", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".worktrees", "output", ".pytest_cache", ".cache", "Vanaras.app"]);
const TEXT_EXT = /\.(?:m?[jt]sx?|cjs|html?|css|scss|vue|svelte|py|rs|go|java|kt|swift|cs|scala|c|cc|cpp|h|hpp|m|mm|rb|php|sh|zsh|bash|sql|md|mdx|txt|json|ya?ml|toml|ini|cfg|xml|csv|env\.example|gradle|proto|graphql)$/i;

const indexes = new Map();
const locks = new Map();
let embedderDownUntil = 0;
let embedderDownReason = "";

function indexFile(root) {
  return path.join(INDEX_DIR, `${crypto.createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`);
}

function walk(root) {
  const files = [];
  const stack = [""];
  while (stack.length && files.length < MAX_FILES) {
    const rel = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith("output_test")) stack.push(childRel);
      } else if (e.isFile() && TEXT_EXT.test(e.name)) {
        files.push(childRel);
      }
    }
  }
  return files;
}

// Small Buffers share one pooled ArrayBuffer, so copy exactly this vector's bytes before viewing them.
function decodeVector(b64) {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function loadIndex(root) {
  if (indexes.has(root)) return indexes.get(root);
  let idx = { root, model: EMBED_MODEL, dims: EMBED_DIMS, files: {}, chunks: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(indexFile(root), "utf8"));
    if (saved.root === root) {
      idx = saved;
      for (const c of idx.chunks) c.vec = c.vec && saved.model === EMBED_MODEL ? decodeVector(c.vec) : null;
      idx.model = EMBED_MODEL;
    }
  } catch {}
  idx.bm25 = null;
  indexes.set(root, idx);
  return idx;
}

function saveIndex(idx) {
  try {
    fs.mkdirSync(INDEX_DIR, { recursive: true });
    const data = {
      root: idx.root,
      model: idx.model,
      dims: idx.dims,
      files: idx.files,
      chunks: idx.chunks.map(c => ({ ...c, vec: c.vec ? Buffer.from(c.vec.buffer, c.vec.byteOffset, c.vec.byteLength).toString("base64") : null }))
    };
    const file = indexFile(idx.root);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
    fs.renameSync(`${file}.tmp`, file);
  } catch (e) {
    console.warn("Could not save code index:", e.message);
  }
}

// Brings the index in line with the folder: unchanged files (same size and mtime) are not even read.
function refreshFiles(idx) {
  const seen = new Set();
  let changed = false;
  const byPath = new Map();
  for (const c of idx.chunks) {
    if (!byPath.has(c.path)) byPath.set(c.path, []);
    byPath.get(c.path).push(c);
  }
  const next = [];
  for (const rel of walk(idx.root)) {
    seen.add(rel);
    const abs = path.join(idx.root, rel);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.size > MAX_FILE_BYTES) continue;
    const prev = idx.files[rel];
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
      next.push(...(byPath.get(rel) || []));
      continue;
    }
    let text;
    try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
    if (text.includes("\u0000")) continue;
    const hash = crypto.createHash("sha1").update(text).digest("hex");
    if (prev && prev.hash === hash) {
      idx.files[rel] = { size: st.size, mtimeMs: st.mtimeMs, hash };
      next.push(...(byPath.get(rel) || []));
      continue;
    }
    // Reuse vectors for chunks whose text did not change, so an edit re-embeds only what it touched.
    const oldVecs = new Map((byPath.get(rel) || []).map(c => [c.hash, c.vec]));
    for (const c of chunkFile(rel, text)) {
      c.hash = crypto.createHash("sha1").update(c.text).digest("hex");
      c.vec = oldVecs.get(c.hash) || null;
      next.push(c);
    }
    idx.files[rel] = { size: st.size, mtimeMs: st.mtimeMs, hash };
    changed = true;
  }
  for (const rel of Object.keys(idx.files)) {
    if (!seen.has(rel)) {
      delete idx.files[rel];
      changed = true;
    }
  }
  idx.chunks = next.filter(c => idx.files[c.path]);
  if (changed || !idx.bm25) {
    idx.bm25 = new Bm25Index(idx.chunks.map(c => `${c.path} ${c.symbol} ${c.symbol} ${c.symbol} ${c.text}`));
  }
  return changed;
}

async function embed(inputs) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs, truncate: true }),
    signal: AbortSignal.timeout(60000)
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${body.slice(0, 200)}`);
  const data = JSON.parse(body);
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== inputs.length) throw new Error("Ollama returned no embeddings");
  return data.embeddings.map(v => normalizeVector(v, EMBED_DIMS));
}

function embedderAvailable() {
  return Date.now() >= embedderDownUntil;
}

function markEmbedderDown(err) {
  embedderDownUntil = Date.now() + 60000;
  embedderDownReason = /requires a newer version|not found|pull/i.test(err.message)
    ? `${EMBED_MODEL} is not available in Ollama (${err.message.slice(0, 120)})`
    : err.message.slice(0, 160);
}

// EmbeddingGemma expects task prompts: a query and a document are embedded differently.
const docInput = c => `title: ${c.symbol || path.basename(c.path)} | text: ${c.path}\n${c.text}`.slice(0, EMBED_CHARS);
const queryInput = q => `task: code retrieval | query: ${q}`;

async function embedPending(idx, deadline) {
  const pending = idx.chunks.filter(c => !c.vec);
  for (let i = 0; i < pending.length && Date.now() < deadline && embedderAvailable(); i += EMBED_BATCH) {
    const batch = pending.slice(i, i + EMBED_BATCH);
    try {
      const vecs = await embed(batch.map(docInput));
      batch.forEach((c, j) => { c.vec = vecs[j]; });
    } catch (err) {
      markEmbedderDown(err);
      break;
    }
  }
  return idx.chunks.filter(c => !c.vec).length;
}

async function withLock(root, fn) {
  const prev = locks.get(root) || Promise.resolve();
  let release;
  const mine = new Promise(r => { release = r; });
  locks.set(root, prev.then(() => mine));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

// Builds or refreshes the index for `root`. Embedding is time-boxed: a first build of a large folder keeps
// working in the background while searches use the keyword half plus whatever vectors already exist.
export async function refreshIndex(root, { embedBudgetMs = 15000 } = {}) {
  return withLock(root, async () => {
    const idx = loadIndex(root);
    const changed = refreshFiles(idx);
    const before = idx.chunks.filter(c => !c.vec).length;
    // A zero budget means keyword-only use: no embedding now and none scheduled in the background.
    const remaining = before && embedBudgetMs > 0 ? await embedPending(idx, Date.now() + embedBudgetMs) : before;
    if (changed || remaining !== before) saveIndex(idx);
    if (embedBudgetMs > 0 && remaining > 0 && embedderAvailable() && !idx.backgroundRunning) {
      idx.backgroundRunning = true;
      setTimeout(() => {
        refreshIndex(root, { embedBudgetMs: 120000 }).finally(() => { idx.backgroundRunning = false; });
      }, 50);
    }
    return idx;
  });
}

export async function codeSearch(root, query, { limit = 8, pathPrefix = "", budgetChars = 7000, semantic: useSemantic = true } = {}) {
  const t0 = Date.now();
  const q = String(query || "").trim();
  if (!q) throw new Error("query is required");
  const idx = await refreshIndex(root, useSemantic ? {} : { embedBudgetMs: 0 });
  const prefix = String(pathPrefix || "").replace(/^\.?\/+/, "").replace(/\/+$/, "");
  const inScope = id => !prefix || idx.chunks[id].path === prefix || idx.chunks[id].path.startsWith(`${prefix}/`);

  const lists = [{ name: "keyword", results: idx.bm25.search(q, 60).filter(r => inScope(r.id)) }];
  const embedded = idx.chunks.filter(c => c.vec).length;
  let semantic = { enabled: false, model: EMBED_MODEL, coverage: idx.chunks.length ? embedded / idx.chunks.length : 0, reason: "" };
  if (useSemantic && embedded > 0 && embedderAvailable()) {
    try {
      const [qv] = await embed([queryInput(q)]);
      lists.push({ name: "semantic", results: vectorSearch(qv, idx.chunks.map(c => c.vec), 60).filter(r => inScope(r.id)) });
      semantic.enabled = true;
    } catch (err) {
      markEmbedderDown(err);
    }
  }
  if (!semantic.enabled) semantic.reason = !useSemantic ? "disabled for this search" : (embedderDownReason || (embedded === 0 ? "no chunks embedded yet" : ""));

  const fused = demoteTests(fuseRankings(lists), idx.chunks, q).slice(0, Math.max(1, Math.min(25, Number(limit) || 8)));
  const results = fused.map(f => {
    const c = idx.chunks[f.id];
    const snip = bestSnippet(c, q);
    return { path: c.path, start: snip.start, end: snip.end, symbol: c.symbol, via: f.via, score: Number(f.score.toFixed(5)), text: snip.text };
  });
  const formatted = formatResults(results, { budgetChars });
  return {
    query: q,
    results: results.slice(0, formatted.shown),
    text: formatted.text,
    semantic,
    files: Object.keys(idx.files).length,
    chunks: idx.chunks.length,
    tookMs: Date.now() - t0
  };
}

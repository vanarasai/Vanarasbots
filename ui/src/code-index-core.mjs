// Hybrid code search with no I/O: declaration-aware chunking, identifier-aware BM25, vector similarity,
// reciprocal-rank fusion, and passage formatting under a size budget.

const CODE_BOUNDARY = {
  js: /^\s{0,6}(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^\s{0,6}(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)|^\s{0,6}(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  py: /^\s{0,4}(?:async\s+)?def\s+([A-Za-z_]\w*)|^\s{0,4}class\s+([A-Za-z_]\w*)/,
  rs: /^\s{0,4}(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|mod|impl(?:<[^>]*>)?)\s+([A-Za-z_]\w*)/,
  go: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|^type\s+([A-Za-z_]\w*)/,
  java: /^\s{0,4}(?:(?:public|private|protected|static|final|abstract|override|suspend|internal|open)\s+)*(?:class|interface|enum|record|fun|func|void|[A-Z][\w<>[\],]*)\s+([A-Za-z_]\w*)\s*[({<]/,
  objc: /^[-+]\s*\([^)]*\)\s*([A-Za-z_]\w*)|^@(?:implementation|interface)\s+([A-Za-z_]\w*)/,
  md: /^#{1,6}\s+(.+)$/
};

const LANG_BY_EXT = {
  ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "js", ".ts": "js", ".tsx": "js", ".html": "js", ".htm": "js", ".vue": "js", ".svelte": "js",
  ".py": "py", ".rs": "rs", ".go": "go",
  ".java": "java", ".kt": "java", ".swift": "java", ".cs": "java", ".scala": "java", ".c": "java", ".cc": "java", ".cpp": "java", ".h": "java", ".hpp": "java",
  ".m": "objc", ".mm": "objc",
  ".md": "md", ".mdx": "md"
};

export function languageFor(relPath) {
  const m = /\.[^./]+$/.exec(String(relPath || "").toLowerCase());
  return (m && LANG_BY_EXT[m[0]]) || "text";
}

const MAX_CHUNK_LINES = 120;
const WINDOW = 80;
const OVERLAP = 10;
const MIN_LINES = 4;

function windows(start, end) {
  const out = [];
  for (let s = start; s <= end; s += WINDOW - OVERLAP) {
    out.push([s, Math.min(end, s + WINDOW - 1)]);
    if (s + WINDOW - 1 >= end) break;
  }
  return out;
}

// Splits a file at declarations (functions, classes, headings) so a result is a whole unit of meaning, not
// an arbitrary slice. Long units are windowed with overlap; tiny ones are merged into the next.
export function chunkFile(relPath, text) {
  const lines = String(text || "").split("\n");
  const lang = languageFor(relPath);
  const rx = CODE_BOUNDARY[lang];
  let starts = [];
  if (rx) {
    lines.forEach((line, i) => {
      const m = rx.exec(line);
      if (m) starts.push({ line: i + 1, indent: /^\s*/.exec(line)[0].length, symbol: (m.slice(1).find(Boolean) || "").trim().slice(0, 80) });
    });
  }
  // In JS a helper declared inside a function (`const wait = () => ...`) is deeper than the file's top-level
  // declarations; splitting there would cut its enclosing function in two. (Python methods stay separate.)
  if (lang === "js" && starts.length) {
    const base = Math.min(...starts.map(st => st.indent));
    starts = starts.filter(st => st.indent <= base);
  }
  // A comment block directly above a declaration describes it, so it starts that declaration's chunk instead
  // of trailing the previous one (otherwise "why" text is found next to the wrong code).
  if (lang !== "md") {
    const isComment = l => /^\s*(?:\/\/|#(?!include|!)|\/\*|\*|""")/.test(l);
    starts.forEach((st, i) => {
      const floor = i > 0 ? starts[i - 1].line + 1 : 1;
      let line = st.line;
      while (line - 1 >= floor && isComment(lines[line - 2])) line--;
      st.line = line;
    });
  }
  const segments = [];
  if (starts.length === 0) {
    for (const [s, e] of windows(1, lines.length)) segments.push({ start: s, end: e, symbol: "" });
  } else {
    if (starts[0].line > 1) segments.push({ start: 1, end: starts[0].line - 1, symbol: "" });
    starts.forEach((st, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].line - 1 : lines.length;
      segments.push({ start: st.line, end, symbol: st.symbol });
    });
  }
  const merged = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    if (prev && prev.end - prev.start + 1 < MIN_LINES) {
      prev.end = seg.end;
      prev.symbol = prev.symbol || seg.symbol;
    } else {
      merged.push({ ...seg });
    }
  }
  const chunks = [];
  for (const seg of merged) {
    const parts = seg.end - seg.start + 1 > MAX_CHUNK_LINES ? windows(seg.start, seg.end) : [[seg.start, seg.end]];
    for (const [s, e] of parts) {
      const body = lines.slice(s - 1, e).join("\n");
      if (!body.trim()) continue;
      chunks.push({ path: relPath, start: s, end: e, symbol: seg.symbol, text: body });
    }
  }
  return chunks;
}

// Light suffix folding so "processes"/"process", "created"/"create", "counting"/"count" meet. Deliberately
// crude (no dictionary): it only has to map a query word and a code word onto the same key.
export function stem(word) {
  let w = String(word);
  if (w.length <= 4) return w;
  if (w.endsWith("ies") && w.length > 5) w = `${w.slice(0, -3)}y`;
  else if (/(?:ss|sh|ch|x|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);
  else if (w.endsWith("ing") && w.length > 6) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 5) w = w.slice(0, -2);
  // "create" and "created" (-> "creat") must meet, so a trailing e is dropped too.
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  return w;
}

const STOPWORDS = new Set("a an and are as at be by do does for from how i if in is it of on or the this to we what when where which who why with you our".split(" "));

// Identifiers are indexed whole and split (parsePersonaList -> parsepersonalist, parse, persona, list), so
// both an exact symbol and the words inside it match.
export function tokenize(text) {
  const out = [];
  for (const word of String(text || "").match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g) || []) {
    const whole = word.toLowerCase();
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[_\s]+/)
      .map(p => p.toLowerCase())
      .filter(p => p.length > 1);
    if (whole.length > 1 && !STOPWORDS.has(whole)) out.push(stem(whole));
    if (parts.length > 1) for (const p of parts) if (!STOPWORDS.has(p)) out.push(stem(p));
  }
  return out;
}

export class Bm25Index {
  constructor(docs, { k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.postings = new Map();
    this.lengths = [];
    docs.forEach((doc, id) => {
      const terms = tokenize(doc);
      this.lengths[id] = terms.length;
      const tf = new Map();
      for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
      for (const [t, n] of tf) {
        if (!this.postings.has(t)) this.postings.set(t, []);
        this.postings.get(t).push([id, n]);
      }
    });
    this.n = docs.length;
    this.avgLen = this.lengths.reduce((s, x) => s + x, 0) / Math.max(1, this.n);
  }

  search(query, limit = 50) {
    const scores = new Map();
    for (const t of new Set(tokenize(query))) {
      const posting = this.postings.get(t);
      if (!posting) continue;
      const idf = Math.log(1 + (this.n - posting.length + 0.5) / (posting.length + 0.5));
      for (const [id, tf] of posting) {
        const norm = tf * (this.k1 + 1) / (tf + this.k1 * (1 - this.b + this.b * (this.lengths[id] / this.avgLen)));
        scores.set(id, (scores.get(id) || 0) + idf * norm);
      }
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id, score]) => ({ id, score }));
  }
}

// Matryoshka embeddings keep their meaning when truncated; normalise after truncating so dot = cosine.
export function normalizeVector(values, dims) {
  const v = Float32Array.from(dims ? values.slice(0, dims) : values);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

export function vectorSearch(queryVec, vectors, limit = 50) {
  const scored = [];
  vectors.forEach((v, id) => {
    if (!v || v.length !== queryVec.length) return;
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * queryVec[i];
    scored.push({ id, score: dot });
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Tests repeat the vocabulary of the code they test, so they compete with it for every query, and their
// literals (timeouts, sample values) then get quoted as if they were the real behaviour. Unless the query is
// about tests, a test file's fused score is halved.
export function isTestPath(relPath) {
  const p = String(relPath || "").toLowerCase();
  return /(?:^|\/)(?:tests?|__tests__|spec|specs|e2e)\//.test(p) || /(?:^|\/)test_[^/]*$|[._-](?:test|spec)\.[a-z0-9]+$|_test\.(?:go|py|rs)$/.test(p);
}

export function queryWantsTests(query) {
  return /\b(?:tests?|testing|tested|spec|specs|e2e|unit test|fixtures?)\b/i.test(String(query || ""));
}

export function demoteTests(fused, chunks, query, factor = 0.5) {
  if (queryWantsTests(query)) return fused;
  return fused
    .map(f => (isTestPath(chunks[f.id]?.path) ? { ...f, score: f.score * factor } : f))
    .sort((a, b) => b.score - a.score);
}

// Reciprocal-rank fusion: robust to the two lists having incomparable score scales.
export function fuseRankings(lists, k = 60) {
  const fused = new Map();
  for (const { name, results } of lists) {
    results.forEach((r, rank) => {
      const cur = fused.get(r.id) || { id: r.id, score: 0, via: [] };
      cur.score += 1 / (k + rank + 1);
      cur.via.push(name);
      fused.set(r.id, cur);
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score);
}

// The most relevant window of a chunk: the run of lines with the most query-term hits.
export function bestSnippet(chunk, query, maxLines = 30) {
  const lines = chunk.text.split("\n");
  if (lines.length <= maxLines) return { start: chunk.start, end: chunk.end, text: chunk.text };
  const terms = new Set(tokenize(query));
  const hits = lines.map(l => tokenize(l).filter(t => terms.has(t)).length);
  let best = 0;
  let bestSum = -1;
  let sum = 0;
  for (let i = 0; i < lines.length; i++) {
    sum += hits[i];
    if (i >= maxLines) sum -= hits[i - maxLines];
    if (i >= maxLines - 1 && sum > bestSum) {
      bestSum = sum;
      best = i - maxLines + 1;
    }
  }
  return { start: chunk.start + best, end: chunk.start + best + maxLines - 1, text: lines.slice(best, best + maxLines).join("\n") };
}

export function formatResults(results, { budgetChars = 7000 } = {}) {
  let out = "";
  let shown = 0;
  for (const r of results) {
    const head = `── ${r.path}:${r.start}-${r.end}${r.symbol ? ` (${r.symbol})` : ""} [${r.via.join("+")}]\n`;
    const numbered = r.text.split("\n").map((l, i) => `${String(r.start + i).padStart(5)}  ${l}`).join("\n");
    const block = `${head}${numbered}\n`;
    if (shown > 0 && out.length + block.length > budgetChars) break;
    out += block.length > budgetChars ? `${block.slice(0, budgetChars)}\n…\n` : block;
    shown++;
  }
  return { text: out.trimEnd(), shown };
}

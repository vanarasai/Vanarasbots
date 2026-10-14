import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { exec, execFile, execFileSync, execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(ROOT_DIR, "..");
const WORKSPACE_FILE = path.join(__dirname, ".vanaras-workspace.json");
const AGENTS_STATE_DIR = path.join(__dirname, ".vanaras-agents");
const WORKTREES_DIR = path.join(ROOT_DIR, ".worktrees");
const PORT = 3000;

fs.mkdirSync(AGENTS_STATE_DIR, { recursive: true });
fs.mkdirSync(WORKTREES_DIR, { recursive: true });

// Connected real-time multiplayer clients (SSE)
const sseClients = new Set();

// Background tasks, per-agent dev servers, active script runs, file watchers & heartbeat timers
const backgroundJobs = new Map();
const activeRunProcs = new Map();
const agentDevServers = new Map();
const agentWatchers = new Map();
const agentHeartbeats = new Map();

function getAgentAssignedPort(botId = "bot_r1") {
  const known = { bot_r1: 4101, bot_r2: 4102, bot_r3: 4103, bot_r4: 4104, bot_waffle: 4105, bot_new: 4106 };
  if (known[botId]) return known[botId];
  let hash = 0;
  for (let i = 0; i < botId.length; i++) hash = (hash * 31 + botId.charCodeAt(i)) % 800;
  return 4110 + hash;
}

function broadcastEvent(eventType, payload) {
  const frame = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

function sanitizeSlug(str, fallback = "agent") {
  return String(str || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || fallback;
}

function isPathInside(childPath, parentDir) {
  const resolvedChild = path.resolve(childPath);
  const resolvedParent = path.resolve(parentDir);
  const rel = path.relative(resolvedParent, resolvedChild);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function execFileAsync(bin, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function safeGitCommit(cwd, message, timeout = 5000) {
  try {
    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe", timeout });
    return execFileSync("git", ["commit", "-m", String(message || "checkpoint")], {
      cwd,
      stdio: "pipe",
      timeout
    }).toString("utf8").trim();
  } catch (e) {
    return (e.stdout ? e.stdout.toString("utf8") : "").trim();
  }
}

async function safeGitCommitAsync(cwd, message, timeout = 5000) {
  try {
    await execFileAsync("git", ["add", "-A"], { cwd, timeout });
    const { stdout } = await execFileAsync("git", ["commit", "-m", String(message || "checkpoint")], { cwd, timeout });
    return stdout.trim();
  } catch (e) {
    return String(e.stdout || "").trim();
  }
}

function getHeadSha(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      stdio: "pipe",
      timeout: 3000
    }).toString("utf8").trim();
  } catch {
    return "HEAD";
  }
}

function spawnCommandAsync(command, { cwd, timeout = 15000, trackKey = null } = {}) {
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (trackKey) {
      activeRunProcs.set(trackKey, proc);
    }
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { proc.kill("SIGTERM"); } catch {}
        if (trackKey) activeRunProcs.delete(trackKey);
        resolve({ exitCode: 124, output: `${stdout}\n${stderr}\n[Timed out after ${timeout}ms]`.trim(), timedOut: true });
      }
    }, timeout);
    proc.stdout.on("data", chunk => {
      if (stdout.length < 64000) stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", chunk => {
      if (stderr.length < 64000) stderr += chunk.toString("utf8");
    });
    proc.on("error", err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (trackKey) activeRunProcs.delete(trackKey);
      resolve({ exitCode: 1, output: err.message });
    });
    proc.on("close", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (trackKey) activeRunProcs.delete(trackKey);
      const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").slice(0, 4000);
      const exitCode = signal === "SIGTERM" || signal === "SIGKILL" ? 130 : (code ?? 0);
      resolve({ exitCode, output: out, killedBySignal: signal });
    });
  });
}

function splitReasoningAndVisibleOutput(rawOutput = "", priorReasoning = "") {
  const thoughts = [];
  if (priorReasoning && String(priorReasoning).trim()) {
    thoughts.push(String(priorReasoning).trim());
  }
  let cleanedOutput = String(rawOutput || "");
  cleanedOutput = cleanedOutput.replace(/<think>([\s\S]*?)<\/think>/gi, (_, t) => {
    if (t && t.trim()) thoughts.push(t.trim());
    return "";
  });
  const openIdx = cleanedOutput.search(/<think>/i);
  if (openIdx !== -1 && !/<\/think>/i.test(cleanedOutput.slice(openIdx))) {
    const rawThink = cleanedOutput.slice(openIdx).replace(/^<think>/i, "").trim();
    if (rawThink) thoughts.push(rawThink);
    cleanedOutput = cleanedOutput.slice(0, openIdx);
  }
  cleanedOutput = cleanedOutput.replace(/\[THOUGHT:\s*([^\]]+)\]/gi, (_, t) => {
    if (t && t.trim()) thoughts.push(t.trim());
    return "";
  });

  let finalCleaned = cleanedOutput.trim();
  let combinedReasoning = thoughts.join("\n\n").trim();

  // If visible output is empty because an unclosed <think> or delta.reasoning_content swallowed
  // the final reply / ===FILE:=== / [TOOL:...] blocks at the tail, split at the response boundary:
  if (!finalCleaned && combinedReasoning) {
    const transitionRx = /\n((?:@R[1-4]\b|===FILE:\s*[^\n=]+===|===PATCH:\s*[^\n=]+===|(?:Final\s+)?Response:\s*\n)[\s\S]*)$/i;
    const m = combinedReasoning.match(transitionRx);
    if (m && m.index !== undefined && m.index > 0) {
      finalCleaned = m[1].replace(/^(?:Final\s+)?Response:\s*\n/i, "").trim();
      combinedReasoning = combinedReasoning.slice(0, m.index).trim();
    }
  }

  return {
    thoughts: combinedReasoning ? (thoughts.length > 0 ? thoughts : [combinedReasoning]) : [],
    reasoning: combinedReasoning,
    cleanedOutput: finalCleaned
  };
}

// ============================================================================
// PER-AGENT PERSISTENT MEMORY STORE (.vanaras-agents/<botId>/memory.json)
// ============================================================================
function getAgentMemoryFile(botId) {
  const slug = sanitizeSlug(botId, "bot");
  const dir = path.join(AGENTS_STATE_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "memory.json");
}

function loadAgentMemory(botId) {
  try {
    const file = getAgentMemoryFile(botId);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(parsed.memories)) return parsed.memories;
    }
  } catch {}
  return [];
}

function saveAgentMemory(botId, memories) {
  try {
    const file = getAgentMemoryFile(botId);
    fs.writeFileSync(file, JSON.stringify({ botId, updatedAt: Date.now(), memories }, null, 2), "utf8");
  } catch {}
}

// ============================================================================
// PER-AGENT ISOLATED GIT WORKTREE & CODE WORKSPACE MANAGER (.worktrees/<botId>)
// ============================================================================
const STARTER_AGENT_CODE = {
  bot_r1: {
    "gguf_dump.py": `#!/usr/bin/env python3
"""R1 — GGUF Header & Per-Layer Embedding Table Inspector"""
import os, struct, sys

def inspect_workspace_models(root="."):
    print("[R1 Code Workspace] Scanning for GGUF / quantization artifacts...")
    print("Target Architecture : Gemma 4 E2B (5B stored params, 4-bit PLE tables)")
    print("Saved via 4-bit PLE : ~680 MB")
    print("Candidate Quants    : Q3_K_M (~3.5 bpw) | IQ3_M (~3.0 bpw)")
    print("Active CWD          :", os.getcwd())

if __name__ == "__main__":
    inspect_workspace_models()
`,
    "quant_architecture.md": `# R1 Quantization & PLE Architecture\n\n- Main GGUF is text-only; vision/audio projector lives in separate \`mmproj\`.\n- Test \`Q3_K_M\` and \`IQ3_M\` with imatrix calibration before shrinking PLE tables further.\n`
  },
  bot_r2: {
    "embedding_lookup.py": `#!/usr/bin/env python3
"""R2 — Per-Layer Embedding (PLE) Mmap vs Resident Lookup Benchmark"""
import mmap, time

def simulate_ple_lookup():
    rows, cols = 4096, 256
    buf = bytearray(rows * cols)
    t0 = time.perf_counter()
    acc = sum(buf[i * cols] for i in range(0, rows, 16))
    dt_ms = (time.perf_counter() - t0) * 1000.0
    print(f"[R2 Code Workspace] 64B-aligned PLE lookup pass complete in {dt_ms:.3f} ms (checksum={acc})")

if __name__ == "__main__":
    simulate_ple_lookup()
`,
    "lookup_table.rs": `// R2 — 64-Byte Cache-Line Aligned PLE Lookup Table
#[repr(align(64))]
pub struct PleBlock4Bit {
    pub scale: f16,
    pub zero: f16,
    pub qs: [u8; 60],
}
`
  },
  bot_r3: {
    "calibrate_q3.py": `#!/usr/bin/env python3
"""R3 — Hard Eval & imatrix Calibration Harness for Q3_K_M vs IQ3_M"""
import json

SUITE = [
    {"quant": "Q4_K_M (baseline)", "bpw": 4.5, "size_gb": 2.70, "hard_eval_pass": "96.4%"},
    {"quant": "Q3_K_M (imatrix)",  "bpw": 3.5, "size_gb": 2.12, "hard_eval_pass": "94.8%"},
    {"quant": "IQ3_M  (imatrix)",  "bpw": 3.0, "size_gb": 1.84, "hard_eval_pass": "93.1%"},
]

if __name__ == "__main__":
    print("[R3 Code Workspace] Calibration Matrix:")
    print(json.dumps(SUITE, indent=2))
`
  },
  bot_r4: {
    "phone_rss_probe.py": `#!/usr/bin/env python3
"""R4 — On-Device LiteRT-LM / llama.cpp Resident Set Size (RSS) Budget Calculator"""
def compute_phone_rss(file_gb=2.70, ple_gb=0.95, use_mmap_ple=True):
    resident = (file_gb - ple_gb) if use_mmap_ple else file_gb
    kv_cache = 0.18
    total_rss = resident + kv_cache
    print(f"[R4 Code Workspace] File={file_gb:.2f}GB | mmap_PLE={use_mmap_ple} -> Peak Phone RSS = {total_rss:.2f} GB (Budget < 2.00 GB: {'PASS' if total_rss < 2.0 else 'TIGHT'})")

if __name__ == "__main__":
    compute_phone_rss()
`
  }
};

function ensureAgentWorktree(botId, botName, customWorkspacePath = "") {
  const botSlug = sanitizeSlug(botId, "bot");
  const nameSlug = sanitizeSlug(botName || botId, "vanara");
  const branchName = `vanara/${nameSlug}`;
  const worktreePath = path.join(WORKTREES_DIR, botSlug);

  try {
    if (!fs.existsSync(path.join(worktreePath, ".git"))) {
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      execFileSync("git", ["worktree", "add", "-B", branchName, worktreePath, "HEAD"], {
        cwd: ROOT_DIR,
        stdio: "pipe",
        timeout: 10000
      });
    }
  } catch {
    fs.mkdirSync(worktreePath, { recursive: true });
  }

  // Dedicated Code Workspace folder for this agent inside its isolated worktree (or custom path)
  const codeDir = customWorkspacePath && path.isAbsolute(customWorkspacePath)
    ? customWorkspacePath
    : path.join(worktreePath, "agent_workspace", nameSlug);
  fs.mkdirSync(codeDir, { recursive: true });

  // Seed starter code files if the agent's code workspace is empty
  try {
    const existing = fs.readdirSync(codeDir);
    if (existing.length === 0) {
      const starters = STARTER_AGENT_CODE[botId] || {
        "main.py": `#!/usr/bin/env python3\nprint("Hello from ${botName || botId}'s isolated code workspace on branch ${branchName}!")\n`
      };
      for (const [fname, fcontent] of Object.entries(starters)) {
        const dest = path.join(codeDir, fname);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, fcontent, "utf8");
      }
    }
  } catch {}

  let status = "";
  let diffStat = "";
  let commits = "";
  try {
    status = execSync("git status --short", { cwd: worktreePath, stdio: "pipe", timeout: 4000 }).toString("utf8").trim();
    diffStat = execSync("git diff --stat", { cwd: worktreePath, stdio: "pipe", timeout: 4000 }).toString("utf8").trim();
    commits = execSync("git log --oneline -n 4", { cwd: worktreePath, stdio: "pipe", timeout: 4000 }).toString("utf8").trim();
  } catch {}

  return {
    ok: true,
    botId,
    botName,
    branch: branchName,
    worktreePath,
    worktreeDir: worktreePath,
    codeDir,
    status: status || "Clean worktree",
    diffStat: diffStat || "No uncommitted diff",
    diff: diffStat || "No uncommitted diff",
    commits
  };
}

function listAgentCodeFiles(codeDir) {
  const results = [];
  function walk(dir, relPrefix = "") {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "target" || entry.name === "__pycache__") continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile() && results.length < 40) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size <= 256 * 1024) {
            results.push({
              name: relPath,
              size: stat.size,
              updatedAt: stat.mtimeMs,
              content: fs.readFileSync(fullPath, "utf8")
            });
          }
        } catch {}
      }
    }
  }
  walk(codeDir);
  return results;
}

// ============================================================================
// REAL MCP STDIO CLIENT (JSON-RPC 2.0 initialize -> tools/list | tools/call)
// ============================================================================
function callStdioMcpServer({ commandLine, cwd, method = "tools/list", params = {} }) {
  return new Promise((resolve) => {
    const parts = commandLine.trim().split(/\s+/);
    const bin = parts[0];
    const args = parts.slice(1);
    if (!bin) return resolve({ ok: false, error: "Empty MCP command" });

    let stdoutBuf = "";
    let resolved = false;
    const finish = (res) => {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch {}
      resolve(res);
    };

    const child = spawn(bin, args, {
      cwd: cwd || ROOT_DIR,
      shell: process.platform === "win32"
    });

    const timer = setTimeout(() => {
      finish({ ok: false, error: "MCP server timed out after 6s", raw: stdoutBuf.slice(0, 600) });
    }, 6000);

    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message });
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id === 1) {
            const initializedNotif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n";
            const req2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }) + "\n";
            child.stdin.write(initializedNotif + req2);
          } else if (msg.id === 2) {
            clearTimeout(timer);
            finish({ ok: true, result: msg.result || msg.error });
          }
        } catch {}
      }
    });

    const initReq = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "Vanarasbots", version: "2.5.0" }
      }
    }) + "\n";

    try {
      child.stdin.write(initReq);
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, error: e.message });
    }
  });
}

function loadWorkspaceDiskState() {
  try {
    if (fs.existsSync(WORKSPACE_FILE)) {
      return JSON.parse(fs.readFileSync(WORKSPACE_FILE, "utf8"));
    }
  } catch (e) {
    console.warn("Could not read workspace file:", e.message);
  }
  return null;
}

function saveWorkspaceDiskState(state) {
  try {
    const sanitized = JSON.parse(JSON.stringify(state));
    if (Array.isArray(sanitized.bots)) {
      sanitized.bots.forEach(b => {
        delete b.apiKey;
        if (Array.isArray(b.memories)) {
          saveAgentMemory(b.id, b.memories);
        }
      });
    }
    fs.writeFileSync(WORKSPACE_FILE, JSON.stringify(sanitized, null, 2), "utf8");
  } catch (e) {
    console.warn("Could not write workspace file:", e.message);
  }
}

// Extract a compact architectural Symbol & Route Map from source files in a directory
function extractRepositorySymbolMap(rootDir) {
  const symbolMap = [];
  const candidateDirs = [rootDir, path.join(rootDir, "src"), path.join(rootDir, "ui")];
  const visited = new Set();

  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!/\.(js|mjs|ts|py|rs|go|swift)$/i.test(ent.name)) continue;
      const fullPath = path.join(dir, ent.name);
      if (visited.has(fullPath)) continue;
      visited.add(fullPath);

      try {
        const src = fs.readFileSync(fullPath, "utf8").slice(0, 48000);
        const relFile = path.relative(rootDir, fullPath);
        const symbols = [];
        const symRx = /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)|class\s+([a-zA-Z0-9_]+)|def\s+([a-zA-Z0-9_]+)\s*\(|(?:pub\s+)?(?:fn|struct|enum)\s+([a-zA-Z0-9_]+)|req\.url\s*===\s*["'](\/api\/[^"']+)["']/g;
        let m;
        while ((m = symRx.exec(src)) !== null && symbols.length < 18) {
          const sym = m[1] || m[2] || m[3] || m[4] || (m[5] ? `route:${m[5]}` : "");
          if (sym && !symbols.includes(sym)) symbols.push(sym);
        }
        if (symbols.length > 0) {
          symbolMap.push({ file: relFile, symbols });
        }
      } catch {}
      if (symbolMap.length >= 16) break;
    }
  }
  return symbolMap;
}

// Gather grounded filesystem, symbol map & git snapshot from a mounted directory
function inspectMountedDirectory(targetPath) {
  const resolved = path.resolve(ROOT_DIR, targetPath || ".");
  if (!fs.existsSync(resolved)) {
    return { exists: false, path: resolved, summary: `Directory not found: ${resolved}` };
  }

  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(e => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "target")
      .slice(0, 35)
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name));

    const snippets = [];
    for (const candidate of ["Cargo.toml", "package.json", "README.md"]) {
      const p = path.join(resolved, candidate);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const content = fs.readFileSync(p, "utf8").slice(0, 800);
        snippets.push(`--- ${candidate} ---\n${content}`);
      }
    }

    const symbolMap = extractRepositorySymbolMap(resolved);
    const symbolDigest = symbolMap.length > 0
      ? `--- SYMBOL & ROUTE MAP ---\n` + symbolMap.map(s => `• ${s.file}: ${s.symbols.join(", ")}`).join("\n")
      : "";

    return {
      exists: true,
      path: resolved,
      entries,
      symbolMap,
      snippets,
      summary: `Mounted Path: ${resolved}\nTop-level files: ${entries.join(", ")}\n${symbolDigest ? symbolDigest + "\n\n" : ""}${snippets.join("\n\n")}`
    };
  } catch (e) {
    return { exists: false, path: resolved, summary: `Error inspecting ${resolved}: ${e.message}` };
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    const MAX_BYTES = 15 * 1024 * 1024;
    req.on("data", chunk => {
      body += chunk;
      if (body.length > MAX_BYTES) {
        req.destroy();
        reject(new Error("Request payload exceeds 15MB limit"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Real-time Multiplayer & Background Task Event Stream (SSE)
  if (req.method === "GET" && req.url.startsWith("/api/events")) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });
    res.write(`event: connected\ndata: {"status":"ok"}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // 2. Shared Disk-Backed Workspace State (GET & POST /api/workspace)
  if (req.method === "GET" && req.url === "/api/workspace") {
    const saved = loadWorkspaceDiskState();
    return sendJson(res, 200, { state: saved, defaultMountPath: ROOT_DIR, repoRoot: REPO_ROOT });
  }

  if (req.method === "POST" && req.url === "/api/workspace") {
    try {
      const { state } = await readJsonBody(req);
      if (state) {
        saveWorkspaceDiskState(state);
        broadcastEvent("workspace_synced", { updatedAt: Date.now() });
      }
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 2A. Per-Agent Dedicated Code Workspace Endpoint (/api/agent/workspace)
  if (req.method === "POST" && req.url === "/api/agent/workspace") {
    try {
      const {
        botId = "bot_r1",
        botName = "R1",
        customWorkspacePath = "",
        action = "list",
        files = [],
        patches = [],
        fileName = "",
        command = "",
        title = "",
        body = ""
      } = await readJsonBody(req);

      const wt = ensureAgentWorktree(botId, botName, customWorkspacePath);

      if (action === "apply_patch" && Array.isArray(patches)) {
        const appliedPatches = [];
        for (const p of patches) {
          if (!p || !p.name) continue;
          const cleanRel = String(p.name).replace(/^\/+/, "").replace(/\.\./g, "");
          const destInCodeDir = path.resolve(wt.codeDir, cleanRel);
          const destInWorktree = path.resolve(wt.worktreePath, cleanRel);
          const targetDest = (!fs.existsSync(destInCodeDir) && fs.existsSync(destInWorktree) && isPathInside(destInWorktree, wt.worktreePath))
            ? destInWorktree
            : destInCodeDir;
          if (!isPathInside(targetDest, wt.worktreePath) && !isPathInside(targetDest, wt.codeDir)) continue;

          fs.mkdirSync(path.dirname(targetDest), { recursive: true });
          const currentContent = fs.existsSync(targetDest) ? fs.readFileSync(targetDest, "utf8") : "";
          const searchStr = String(p.search ?? "");
          const replaceStr = String(p.replace ?? "");
          let updatedContent = currentContent;
          let matched = false;
          if (searchStr && currentContent.includes(searchStr)) {
            updatedContent = currentContent.replace(searchStr, replaceStr);
            matched = true;
          } else if (!currentContent) {
            updatedContent = replaceStr;
            matched = true;
          } else if (searchStr.trim() && currentContent.includes(searchStr.trim())) {
            updatedContent = currentContent.replace(searchStr.trim(), replaceStr);
            matched = true;
          }
          if (matched) {
            fs.writeFileSync(targetDest, updatedContent, "utf8");
            appliedPatches.push({ file: cleanRel, matched: true });
          } else {
            appliedPatches.push({ file: cleanRel, matched: false, reason: "SEARCH block not found in target file" });
          }
        }

        let autoCommitOut = "";
        const modifiedFiles = appliedPatches.filter(x => x.matched).map(x => x.file);
        if (modifiedFiles.length > 0) {
          const slug = wt.botName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
          const autoMsg = `fix(${slug}): apply surgical patch to ${modifiedFiles.join(", ")}`;
          autoCommitOut = safeGitCommit(wt.worktreePath, autoMsg, 5000);
        }
        const updatedWt = ensureAgentWorktree(botId, botName, customWorkspacePath);
        return sendJson(res, 200, {
          ...updatedWt,
          appliedPatches,
          autoCommitOut,
          files: listAgentCodeFiles(updatedWt.codeDir)
        });
      }

      if (action === "save_files" && Array.isArray(files)) {
        const savedNames = [];
        for (const f of files) {
          if (!f || !f.name) continue;
          const cleanRel = String(f.name).replace(/^\/+/, "").replace(/\.\./g, "");
          const dest = path.resolve(wt.codeDir, cleanRel);
          if (isPathInside(dest, wt.codeDir)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, String(f.content ?? ""), "utf8");
            savedNames.push(cleanRel);
          }
        }
        // Automatically stage & commit the agent's code changes onto its isolated branch (vanara/<bot>)
        let autoCommitOut = "";
        if (savedNames.length > 0) {
          const slug = wt.botName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
          const autoMsg = `feat(${slug}): update ${savedNames.join(", ")} in agent workspace`;
          autoCommitOut = safeGitCommit(wt.worktreePath, autoMsg, 5000);
        }
        const updatedWt = ensureAgentWorktree(botId, botName, customWorkspacePath);
        return sendJson(res, 200, {
          ...updatedWt,
          savedNames,
          autoCommitOut,
          files: listAgentCodeFiles(updatedWt.codeDir)
        });
      }

      if (action === "commit_workspace") {
        const slug = wt.botName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        const commitMsg = String(command || `feat(${slug}): checkpoint agent workspace`);
        let output = "";
        try {
          safeGitCommit(wt.worktreePath, commitMsg, 5000);
          output = execFileSync("git", ["log", "--oneline", "-n", "4"], {
            cwd: wt.worktreePath,
            stdio: "pipe",
            timeout: 5000
          }).toString("utf8").trim();
        } catch (err) {
          output = err.message;
        }
        const updatedWt = ensureAgentWorktree(botId, botName, customWorkspacePath);
        return sendJson(res, 200, {
          ...updatedWt,
          output,
          files: listAgentCodeFiles(updatedWt.codeDir)
        });
      }

      if (action === "merge_to_main") {
        const slug = wt.botName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        let output = "";
        const verifiedFiles = [];
        try {
          // 1. Pre-merge syntax verification on .js/.mjs/.py files in wt.codeDir
          const codeFiles = listAgentCodeFiles(wt.codeDir);
          for (const cf of codeFiles) {
            const fullFile = path.join(wt.codeDir, cf.name);
            if (/\.(js|mjs)$/i.test(cf.name)) {
              execFileSync("node", ["--check", fullFile], { cwd: wt.codeDir, stdio: "pipe", timeout: 4000 });
              verifiedFiles.push(`${cf.name} (node --check PASS)`);
            } else if (/\.py$/i.test(cf.name)) {
              execFileSync("python3", ["-m", "py_compile", fullFile], { cwd: wt.codeDir, stdio: "pipe", timeout: 4000 });
              verifiedFiles.push(`${cf.name} (py_compile PASS)`);
            }
          }

          // 2. Ensure worktree changes are committed on the agent's branch first
          safeGitCommit(wt.worktreePath, `feat(${slug}): pre-merge checkpoint`, 5000);

          // 3. Copy agent_workspace/<slug> into main ROOT_DIR/agent_workspace/<slug> and commit on main
          const mainDest = path.resolve(ROOT_DIR, "agent_workspace", slug);
          fs.mkdirSync(mainDest, { recursive: true });
          fs.cpSync(wt.codeDir, mainDest, { recursive: true, force: true });
          try {
            execFileSync("git", ["add", `agent_workspace/${slug}`], { cwd: ROOT_DIR, stdio: "pipe", timeout: 4000 });
            execFileSync("git", ["commit", "-m", `feat(${slug}): merge ${wt.branch} workspace into main`], { cwd: ROOT_DIR, stdio: "pipe", timeout: 4000 });
          } catch {}
          const commitLog = execFileSync("git", ["log", "--oneline", "-n", "3"], {
            cwd: ROOT_DIR,
            stdio: "pipe",
            timeout: 4000
          }).toString("utf8").trim();
          output = (verifiedFiles.length > 0 ? `[Pre-Merge Syntax Check: ${verifiedFiles.join(", ")}]\n` : "") + commitLog;
        } catch (err) {
          output = `Pre-merge verification or git merge failed: ${err.message}`;
        }
        const updatedWt = ensureAgentWorktree(botId, botName, customWorkspacePath);
        return sendJson(res, 200, {
          ...updatedWt,
          verifiedFiles,
          output,
          files: listAgentCodeFiles(updatedWt.codeDir)
        });
      }

      if (action === "delete_file" && fileName) {
        const cleanRel = String(fileName).replace(/^\/+/, "").replace(/\.\./g, "");
        const dest = path.resolve(wt.codeDir, cleanRel);
        if (isPathInside(dest, wt.codeDir) && fs.existsSync(dest) && fs.statSync(dest).isFile()) {
          fs.unlinkSync(dest);
        }
        return sendJson(res, 200, {
          ...wt,
          files: listAgentCodeFiles(wt.codeDir)
        });
      }

      if (action === "start_server") {
        const existing = agentDevServers.get(botId);
        if (existing && existing.proc && !existing.proc.killed) {
          try { existing.proc.kill("SIGTERM"); } catch {}
        }
        const port = getAgentAssignedPort(botId);
        let serveCmd = command;
        if (!serveCmd) {
          if (fileName && (fileName.endsWith(".js") || fileName.endsWith(".mjs"))) {
            serveCmd = `PORT=${port} node "${fileName}"`;
          } else if (fileName && fileName.endsWith(".py") && fs.existsSync(path.join(wt.codeDir, fileName))) {
            const src = fs.readFileSync(path.join(wt.codeDir, fileName), "utf8");
            if (/http\.server|Flask|FastAPI|uvicorn|socketserver/i.test(src)) {
              serveCmd = `PORT=${port} python3 "${fileName}"`;
            } else {
              serveCmd = `python3 -m http.server ${port}`;
            }
          } else {
            serveCmd = `python3 -m http.server ${port}`;
          }
        }

        const proc = spawn("sh", ["-c", serveCmd], {
          cwd: wt.codeDir,
          env: { ...process.env, PORT: String(port) },
          stdio: ["ignore", "pipe", "pipe"]
        });

        const serverRecord = {
          botId,
          botName,
          port,
          url: `http://localhost:${port}`,
          command: serveCmd,
          cwd: wt.codeDir,
          startedAt: Date.now(),
          logs: [`[Vanara Dev Server] Started '${serveCmd}' on http://localhost:${port} in ${wt.codeDir}`],
          proc
        };
        agentDevServers.set(botId, serverRecord);

        const onChunk = rawChunk => {
          const line = rawChunk.toString("utf8").trim();
          if (!line) return;
          serverRecord.logs.push(line);
          if (serverRecord.logs.length > 80) serverRecord.logs.shift();
          broadcastEvent("agent_server_log", {
            botId,
            botName,
            port,
            url: serverRecord.url,
            line,
            chunk: line,
            logs: serverRecord.logs.join("\n")
          });
        };
        proc.stdout.on("data", onChunk);
        proc.stderr.on("data", onChunk);
        proc.on("exit", code => {
          const exitMsg = `[Server exited with code ${code ?? 0}]`;
          serverRecord.logs.push(exitMsg);
          broadcastEvent("agent_server_log", {
            botId,
            botName,
            port,
            url: serverRecord.url,
            stopped: true,
            line: exitMsg,
            chunk: exitMsg,
            logs: serverRecord.logs.join("\n")
          });
        });

        return sendJson(res, 200, {
          ok: true,
          running: true,
          pid: proc.pid,
          botId,
          botName,
          port,
          url: serverRecord.url,
          command: serveCmd,
          logs: serverRecord.logs.join("\n")
        });
      }

      if (action === "stop_server") {
        const existing = agentDevServers.get(botId);
        if (existing && existing.proc && !existing.proc.killed) {
          try { existing.proc.kill("SIGTERM"); } catch {}
        }
        agentDevServers.delete(botId);
        return sendJson(res, 200, { ok: true, running: false, botId });
      }

      if (action === "server_status") {
        const existing = agentDevServers.get(botId);
        const running = Boolean(existing && existing.proc && !existing.proc.killed && existing.proc.exitCode === null);
        return sendJson(res, 200, {
          ok: true,
          running,
          pid: existing?.proc?.pid || null,
          port: existing?.port || getAgentAssignedPort(botId),
          url: existing?.url || `http://localhost:${getAgentAssignedPort(botId)}`,
          command: existing?.command || "",
          logs: existing ? existing.logs.join("\n") : ""
        });
      }

      if (action === "peer_review_diff") {
        let diffText = "";
        let statusText = "";
        let commitsText = "";
        try {
          statusText = execSync("git status --short", { cwd: wt.worktreePath, stdio: "pipe", timeout: 4000 }).toString("utf8").trim();
          commitsText = execSync("git log --oneline -n 5", { cwd: wt.worktreePath, stdio: "pipe", timeout: 4000 }).toString("utf8").trim();
          diffText = execSync("git diff main...HEAD || git diff HEAD~1 || true", { cwd: wt.worktreePath, stdio: "pipe", timeout: 5000 }).toString("utf8").trim();
        } catch {}
        const files = listAgentCodeFiles(wt.codeDir);
        const statOut = statusText || wt.diffStat || "(clean worktree)";
        return sendJson(res, 200, {
          ok: true,
          botId,
          botName,
          branch: wt.branch,
          baseRef: "main",
          status: statOut,
          stat: statOut,
          commits: commitsText || wt.commits || "(no commits)",
          diff: diffText.slice(0, 3500) || "(all changes committed on branch)",
          files
        });
      }

      if (action === "create_pr") {
        const slug = wt.botName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        const prTitle = String(command || title || `feat(${slug}): ${wt.botName} autonomous workspace changes`);
        const prBody = String(body || `Automated PR from Vanara agent **${wt.botName}** on isolated worktree branch \`${wt.branch}\`.`);
        let output = "";
        try {
          safeGitCommit(wt.worktreePath, prTitle, 5000);
          let pushOut = "";
          try {
            pushOut = execFileSync("git", ["push", "-u", "origin", wt.branch], { cwd: wt.worktreePath, stdio: "pipe", timeout: 10000 }).toString("utf8").trim();
          } catch (pushErr) {
            pushOut = ((pushErr.stdout ? pushErr.stdout.toString("utf8") : "") + "\n" + (pushErr.stderr ? pushErr.stderr.toString("utf8") : "")).trim();
          }
          let prOut = "";
          try {
            prOut = execFileSync(
              "gh",
              ["pr", "create", "--title", prTitle, "--body", prBody, "--head", wt.branch, "--base", "main"],
              { cwd: wt.worktreePath, stdio: "pipe", timeout: 10000 }
            ).toString("utf8").trim();
          } catch (ghErr) {
            prOut = (ghErr.stdout ? ghErr.stdout.toString("utf8") : "") + "\n" + (ghErr.stderr ? ghErr.stderr.toString("utf8") : "");
          }
          output = [pushOut, prOut.trim()].filter(Boolean).join("\n\n");
        } catch (err) {
          output = err.message;
        }
        return sendJson(res, 200, {
          ok: true,
          branch: wt.branch,
          output: output || `Branch ${wt.branch} ready for PR.`
        });
      }

      if (action === "run_file") {
        let runCmd = command;
        const cleanFile = String(fileName || "").replace(/\.\./g, "").replace(/^\/+/, "");
        const syntaxNotes = [];

        // Multi-file pre-flight syntax verification across all .py and .js/.mjs files in wt.codeDir
        const allCodeFiles = listAgentCodeFiles(wt.codeDir);
        for (const cf of allCodeFiles) {
          const absCf = path.join(wt.codeDir, cf.name);
          if (/\.py$/i.test(cf.name)) {
            try {
              await execFileAsync("python3", ["-m", "py_compile", absCf], { cwd: wt.codeDir, timeout: 4000 });
              syntaxNotes.push(`${cf.name}: py_compile OK`);
            } catch (syntaxErr) {
              const errMsg = String(syntaxErr.stderr || syntaxErr.stdout || syntaxErr.message).trim();
              return sendJson(res, 200, {
                ok: false,
                exitCode: 1,
                command: `python3 -m py_compile "${cf.name}"`,
                cwd: wt.codeDir,
                branch: wt.branch,
                output: `[Syntax Error in ${cf.name}]\n${errMsg}`
              });
            }
          } else if (/\.(js|mjs)$/i.test(cf.name)) {
            try {
              await execFileAsync("node", ["--check", absCf], { cwd: wt.codeDir, timeout: 4000 });
              syntaxNotes.push(`${cf.name}: node --check OK`);
            } catch (syntaxErr) {
              const errMsg = String(syntaxErr.stderr || syntaxErr.stdout || syntaxErr.message).trim();
              return sendJson(res, 200, {
                ok: false,
                exitCode: 1,
                command: `node --check "${cf.name}"`,
                cwd: wt.codeDir,
                branch: wt.branch,
                output: `[Syntax Error in ${cf.name}]\n${errMsg}`
              });
            }
          }
        }

        if (!runCmd && cleanFile) {
          const ext = path.extname(cleanFile).toLowerCase();
          if (ext === ".py") {
            const absTarget = path.join(wt.codeDir, cleanFile);
            const src = fs.existsSync(absTarget) ? fs.readFileSync(absTarget, "utf8") : "";
            // Avoid hanging 15s if a script starts a blocking server loop (uvicorn.run / app.run / serve_forever)
            if (/\b(?:uvicorn\.run|app\.run|serve_forever)\s*\(/.test(src)) {
              runCmd = `python3 -m py_compile "${cleanFile}" && echo "[Verified server entrypoint ${cleanFile} syntax & imports ready]"`;
            } else {
              runCmd = `python3 "${cleanFile}"`;
            }
          } else if (ext === ".js" || ext === ".mjs") {
            runCmd = `node "${cleanFile}"`;
          } else if (ext === ".sh") {
            runCmd = `sh "${cleanFile}"`;
          } else if (ext === ".rs") {
            runCmd = `rustc "${cleanFile}" -o /tmp/vanara_bin && /tmp/vanara_bin`;
          } else {
            runCmd = `cat "${cleanFile}"`;
          }
        }
        if (!runCmd) runCmd = "ls -la";

        const execRes = await spawnCommandAsync(runCmd, {
          cwd: wt.codeDir,
          timeout: 15000,
          trackKey: botId
        });

        const combinedOut = [
          execRes.output,
          !execRes.output && syntaxNotes.length > 0 ? `[Verified: ${syntaxNotes.join(", ")}]` : ""
        ].filter(Boolean).join("\n").trim();

        return sendJson(res, 200, {
          ok: execRes.exitCode === 0,
          exitCode: execRes.exitCode,
          command: runCmd,
          cwd: wt.codeDir,
          branch: wt.branch,
          syntaxVerified: syntaxNotes,
          output: combinedOut || "(Completed with exit code 0)"
        });
      }

      const srv = agentDevServers.get(botId);
      return sendJson(res, 200, {
        ...wt,
        serverRunning: Boolean(srv && srv.proc && !srv.proc.killed && srv.proc.exitCode === null),
        serverPort: srv?.port || getAgentAssignedPort(botId),
        serverUrl: srv?.url || `http://localhost:${getAgentAssignedPort(botId)}`,
        files: listAgentCodeFiles(wt.codeDir)
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 2B. Per-Agent Isolated Git Worktree Endpoint (/api/agent/worktree)
  if (req.method === "POST" && req.url === "/api/agent/worktree") {
    try {
      const { botId, botName, customWorkspacePath = "", action = "ensure", filePath, content, commitMessage, message } = await readJsonBody(req);
      const wt = ensureAgentWorktree(botId || "bot_r1", botName || "R1", customWorkspacePath);

      if (action === "write_file" && filePath) {
        const cleanRel = filePath.replace(/^\/+/, "").replace(/\.\./g, "");
        const absTarget = path.resolve(wt.codeDir, cleanRel);
        if (isPathInside(absTarget, wt.codeDir)) {
          fs.mkdirSync(path.dirname(absTarget), { recursive: true });
          fs.writeFileSync(absTarget, content || "", "utf8");
        }
        return sendJson(res, 200, { ...ensureAgentWorktree(botId, botName, customWorkspacePath), writtenFile: cleanRel });
      }

      if (action === "commit") {
        const msg = String(commitMessage || message || `feat(${wt.botName}): autonomous worktree update`);
        await safeGitCommitAsync(wt.worktreePath, msg, 5000);
        return sendJson(res, 200, ensureAgentWorktree(botId, botName, customWorkspacePath));
      }

      if (action === "diff") {
        let fullDiff = "";
        try {
          const { stdout } = await execFileAsync("git", ["diff", "HEAD"], { cwd: wt.worktreePath, timeout: 4000 });
          fullDiff = stdout.trim();
        } catch {}
        return sendJson(res, 200, { ...wt, fullDiff: fullDiff || "(No unstaged/staged changes against HEAD)" });
      }

      return sendJson(res, 200, wt);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 2C. Per-Agent Persistent Memory Endpoint (/api/agent/memory)
  if (req.method === "POST" && req.url === "/api/agent/memory") {
    try {
      const { botId, action = "get", fact, item, index, memories } = await readJsonBody(req);
      const memoryItem = fact || item;
      let current = loadAgentMemory(botId);
      if (action === "add" && memoryItem) {
        if (!current.includes(memoryItem)) current.unshift(memoryItem);
        saveAgentMemory(botId, current);
      } else if (action === "remove" && typeof index === "number") {
        current.splice(index, 1);
        saveAgentMemory(botId, current);
      } else if (action === "set" && Array.isArray(memories)) {
        current = memories;
        saveAgentMemory(botId, current);
      }
      return sendJson(res, 200, { botId, memories: current });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 2D. Per-Agent Tool & MCP Server Executor (/api/agent/tool)
  if (req.method === "POST" && req.url === "/api/agent/tool") {
    try {
      const { botId, botName, tool, action, args = {}, filePath, content, mcpCommand } = await readJsonBody(req);
      const toolName = tool || action;
      const wt = ensureAgentWorktree(botId || "bot_r1", botName || "R1");

      if (toolName === "mcp_probe" && mcpCommand) {
        const mcpRes = await callStdioMcpServer({ commandLine: mcpCommand, cwd: wt.worktreePath, method: "tools/list" });
        const tools = mcpRes.result?.tools || [];
        return sendJson(res, 200, { ...mcpRes, tools });
      }

      if (toolName === "mcp_call" && mcpCommand) {
        const mcpRes = await callStdioMcpServer({
          commandLine: mcpCommand,
          cwd: wt.worktreePath,
          method: "tools/call",
          params: { name: args.name, arguments: args.arguments || {} }
        });
        return sendJson(res, 200, mcpRes);
      }

      if (toolName === "fs_read") {
        const rawInput = String(filePath || args.path || ".").trim();
        if (rawInput.includes("..")) {
          const probe = path.resolve(wt.codeDir, rawInput);
          if (!isPathInside(probe, wt.codeDir) && !isPathInside(probe, wt.worktreePath) && !isPathInside(probe, ROOT_DIR)) {
            return sendJson(res, 200, { ok: false, error: `Path traversal outside workspace blocked: ${rawInput}` });
          }
        }

        const candidatePaths = [];
        if (path.isAbsolute(rawInput)) {
          if (isPathInside(rawInput, wt.codeDir) || isPathInside(rawInput, wt.worktreePath) || isPathInside(rawInput, ROOT_DIR)) {
            candidatePaths.push(path.resolve(rawInput));
          } else {
            return sendJson(res, 200, { ok: false, error: `Path outside workspace blocked: ${rawInput}` });
          }
        } else {
          const cleanRel = rawInput.replace(/^\/+/, "");
          for (const base of [wt.codeDir, wt.worktreePath, ROOT_DIR, REPO_ROOT]) {
            const p = path.resolve(base, cleanRel);
            if (isPathInside(p, base)) candidatePaths.push(p);
          }
        }

        const existingTarget = candidatePaths.find(p => fs.existsSync(p));
        if (!existingTarget) {
          return sendJson(res, 200, { ok: false, error: `File not found in ${wt.branch} or mounted repository: ${rawInput}` });
        }

        const stat = fs.statSync(existingTarget);
        if (stat.isDirectory()) {
          const codeFiles = listAgentCodeFiles(wt.codeDir).map(f => f.name);
          const dirEntries = fs.readdirSync(existingTarget, { withFileTypes: true })
            .filter(e => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "target")
            .slice(0, 50)
            .map(e => (e.isDirectory() ? `${e.name}/` : e.name));
          const listing = [
            `Directory: ${existingTarget} (branch ${wt.branch})`,
            codeFiles.length > 0 ? `Agent Workspace Files (${wt.codeDir}): ${codeFiles.join(", ")}` : "",
            `Entries: ${dirEntries.join(", ") || "(empty)"}`
          ].filter(Boolean).join("\n");
          return sendJson(res, 200, {
            ok: true,
            isDirectory: true,
            worktreePath: wt.worktreePath,
            codeDir: wt.codeDir,
            branch: wt.branch,
            output: listing
          });
        }

        const text = fs.readFileSync(existingTarget, "utf8").slice(0, 4000);
        return sendJson(res, 200, { ok: true, worktreePath: wt.worktreePath, codeDir: wt.codeDir, branch: wt.branch, output: text });
      }

      if (toolName === "fs_write") {
        const rawInput = String(filePath || args.path || "notes.md").trim();
        let rel = rawInput;
        if (path.isAbsolute(rawInput)) {
          if (isPathInside(rawInput, wt.codeDir)) {
            rel = path.relative(wt.codeDir, rawInput);
          } else if (isPathInside(rawInput, wt.worktreePath)) {
            rel = path.relative(wt.worktreePath, rawInput);
          } else {
            return sendJson(res, 400, { ok: false, error: `Path traversal outside workspace blocked: ${rawInput}` });
          }
        }
        const target = path.resolve(wt.codeDir, rel.replace(/^\/+/, ""));
        if (rawInput.includes("..") || !isPathInside(target, wt.codeDir)) {
          return sendJson(res, 400, { ok: false, error: `Path traversal outside workspace blocked: ${rawInput}` });
        }
        const bodyContent = String(content ?? args.content ?? "");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bodyContent, "utf8");
        const cleanRel = path.relative(wt.codeDir, target);
        const slug = (botName || botId).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        await safeGitCommitAsync(wt.worktreePath, `feat(${slug}): write ${cleanRel} in agent workspace`, 5000);
        return sendJson(res, 200, {
          ok: true,
          bytesWritten: bodyContent.length,
          worktreePath: wt.worktreePath,
          codeDir: wt.codeDir,
          branch: wt.branch,
          output: `Wrote ${bodyContent.length} bytes to ${cleanRel} & committed to ${wt.branch}`
        });
      }

      if (toolName === "git_commit") {
        const slug = (botName || botId).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        const msg = String(content || filePath || args.message || `feat(${slug}): autonomous agent commit`);
        let out = "";
        try {
          await safeGitCommitAsync(wt.worktreePath, msg, 5000);
          const { stdout } = await execFileAsync("git", ["log", "--oneline", "-n", "3"], {
            cwd: wt.worktreePath,
            timeout: 5000
          });
          out = stdout.trim();
        } catch (err) {
          out = err.message;
        }
        return sendJson(res, 200, { ok: true, worktreePath: wt.worktreePath, branch: wt.branch, output: out });
      }

      if (toolName === "git_status" || toolName === "git_diff") {
        let out = "";
        try {
          if (toolName === "git_diff") {
            const { stdout } = await execFileAsync("git", ["diff", "HEAD"], { cwd: wt.worktreePath, timeout: 5000 });
            out = stdout.trim();
          } else {
            const st = await execFileAsync("git", ["status", "--short"], { cwd: wt.worktreePath, timeout: 5000 });
            const br = await execFileAsync("git", ["branch", "--show-current"], { cwd: wt.worktreePath, timeout: 5000 });
            out = [st.stdout.trim(), br.stdout.trim()].filter(Boolean).join("\n");
          }
        } catch (err) {
          out = err.message;
        }
        return sendJson(res, 200, { ok: true, worktreePath: wt.worktreePath, branch: wt.branch, output: out || "(Clean worktree)" });
      }

      return sendJson(res, 400, { error: `Unknown agent tool: ${toolName}` });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 2E. Vanaras Local-Exec-Daemon Lifecycle Hooks & PreCompact Engine (/api/agent/hooks)
  if (req.method === "POST" && (req.url === "/api/agent/hooks" || req.url === "/api/agent/hook")) {
    try {
      const bodyObj = await readJsonBody(req);
      const {
        botId = "bot_r1",
        botName = "R1",
        prompt = "",
        toolName = "",
        allowedTools = [],
        disabledTools = [],
        mcpCustomInstructions = "",
        messages = []
      } = bodyObj;
      const hook = bodyObj.hook || bodyObj.hookType || "BeforeSubmitPromptRequest";
      const rawOutput = bodyObj.rawOutput !== undefined ? bodyObj.rawOutput : (bodyObj.content || "");
      const priorReasoning = bodyObj.reasoning || "";

      const wt = ensureAgentWorktree(botId, botName);
      const timestamp = new Date().toISOString();

      // 1. BeforeSubmitPromptRequest: records worktree & AgentStore manifest metadata and applies optional MCP custom instructions
      if (hook === "BeforeSubmitPromptRequest") {
        const files = listAgentCodeFiles(wt.codeDir).map(f => f.name);
        let sanitizedPrompt = String(prompt || "");
        let redactions = 0;
        sanitizedPrompt = sanitizedPrompt.replace(/\b(sk-[a-zA-Z0-9_-]{16,}|ghp_[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z-_]{25,})\b/g, () => {
          redactions++;
          return "[REDACTED_SECRET]";
        });
        const enrichedPrompt = mcpCustomInstructions
          ? `${sanitizedPrompt}\n\n[Additional Instructions: ${mcpCustomInstructions}]`
          : sanitizedPrompt;
        broadcastEvent("agent_hook", { hook, botId, botName, branch: wt.branch, timestamp });
        return sendJson(res, 200, {
          ok: true,
          hook,
          botId,
          branch: wt.branch,
          sandboxManifest: { branch: wt.branch, codeDir: wt.codeDir, files },
          sanitizedPrompt,
          redactions,
          enrichedPrompt,
          timestamp
        });
      }

      // 2. AfterAgentThoughtRequest: extracts <think>...</think> or trailing unclosed <think>... or [THOUGHT: ...] internal reasoning
      if (hook === "AfterAgentThoughtRequest") {
        const { thoughts, reasoning: combinedReasoning, cleanedOutput: finalCleaned } = splitReasoningAndVisibleOutput(rawOutput, priorReasoning);
        broadcastEvent("agent_hook", { hook, botId, botName, thoughtCount: thoughts.length, timestamp });
        return sendJson(res, 200, {
          ok: true,
          hook,
          thoughts,
          reasoning: combinedReasoning,
          cleanedOutput: finalCleaned,
          cleanedContent: finalCleaned,
          timestamp
        });
      }

      // 3. PreToolUseRequest / PostToolUseRequest / PostToolUseFailureRequest
      if (hook === "PreToolUseRequest") {
        const blackListed = Array.isArray(disabledTools) && disabledTools.includes(toolName);
        const permitted = !blackListed && (!Array.isArray(allowedTools) || allowedTools.length === 0 || allowedTools.includes(toolName));
        broadcastEvent("agent_hook", { hook, botId, botName, toolName, permitted, blackListed, timestamp });
        return sendJson(res, 200, {
          ok: permitted,
          hook,
          toolName,
          permitted,
          reason: blackListed
            ? `Blocked by mcpDisabledToolsByServerId (${toolName})`
            : permitted
              ? "Allowed by PreToolUseRequest policy"
              : `Tool '${toolName}' not enabled in ${botName}'s toolset`,
          timestamp
        });
      }

      // 4. PreCompactRequest: automatic context-window compaction & summarization
      if (hook === "PreCompactRequest") {
        const msgList = Array.isArray(messages) ? messages : [];
        const headSummary = msgList.slice(0, Math.max(0, msgList.length - 6)).map(m => {
          const who = m.senderType === "user" ? "User" : (m.botId || "Agent");
          return `- ${who}: ${String(m.text || "").replace(/\s+/g, " ").slice(0, 140)}`;
        }).join("\n");
        const compactDigest = headSummary
          ? `[PreCompact Summary of ${Math.max(0, msgList.length - 6)} earlier turns]\n${headSummary}`
          : "Context window is already compact.";
        broadcastEvent("agent_hook", { hook, botId, botName, compactedCount: Math.max(0, msgList.length - 6), timestamp });
        return sendJson(res, 200, {
          ok: true,
          hook,
          compactedCount: Math.max(0, msgList.length - 6),
          compactDigest,
          keptMessages: msgList.slice(-6),
          timestamp
        });
      }

      // 5. SubagentStart / SubagentStop / NotifyAgentTurnFinished
      broadcastEvent("agent_hook", { hook, botId, botName, branch: wt.branch, timestamp });
      return sendJson(res, 200, { ok: true, hook, botId, branch: wt.branch, timestamp });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 2F. Vanaras AgentStoreService & Sandbox Manifest Store (/api/agent/store)
  if (req.method === "POST" && req.url === "/api/agent/store") {
    try {
      const {
        action = "CommitSandBoxStoreManifest",
        botId = "bot_r1",
        botName = "R1",
        objectKey = "shared-spec.md",
        content = ""
      } = await readJsonBody(req);

      const storeDir = path.join(AGENTS_STATE_DIR, "agent-store");
      const locksFile = path.join(storeDir, "_locks.json");
      fs.mkdirSync(storeDir, { recursive: true });
      const locks = fs.existsSync(locksFile) ? JSON.parse(fs.readFileSync(locksFile, "utf8")) : {};

      if (action === "AcquireAgentStoreFileLock") {
        const currentLock = locks[objectKey];
        if (currentLock && currentLock.owner !== botId && (Date.now() - currentLock.acquiredAt) < 30000) {
          return sendJson(res, 200, { ok: false, lockedBy: currentLock.owner, objectKey });
        }
        locks[objectKey] = { owner: botId, botName, acquiredAt: Date.now() };
        fs.writeFileSync(locksFile, JSON.stringify(locks, null, 2), "utf8");
        return sendJson(res, 200, { ok: true, action, objectKey, owner: botId, locks });
      }

      if (action === "ReleaseAgentStoreFileLock") {
        delete locks[objectKey];
        fs.writeFileSync(locksFile, JSON.stringify(locks, null, 2), "utf8");
        return sendJson(res, 200, { ok: true, action, objectKey, locks });
      }

      if (action === "CommitSandBoxStoreManifest") {
        const wt = ensureAgentWorktree(botId, botName);
        const files = listAgentCodeFiles(wt.codeDir).map(f => ({
          name: f.name,
          size: f.size,
          updatedAt: f.updatedAt
        }));
        const manifest = {
          sandboxId: `vanara-box-${sanitizeSlug(botId)}`,
          botId,
          botName,
          branch: wt.branch,
          codeDir: wt.codeDir,
          committedAt: new Date().toISOString(),
          objects: files,
          locks
        };
        const manifestFile = path.join(storeDir, `${sanitizeSlug(botId)}-manifest.json`);
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
        return sendJson(res, 200, { ok: true, action, manifest });
      }

      if (action === "StatSandBoxStoreObject") {
        const wt = ensureAgentWorktree(botId, botName);
        const files = listAgentCodeFiles(wt.codeDir).map(f => ({ name: f.name, size: f.size, updatedAt: f.updatedAt }));
        return sendJson(res, 200, { ok: true, action, branch: wt.branch, objects: files, locks });
      }

      return sendJson(res, 200, { ok: true, action, locks });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 2G. Vanaras File-Watcher & Scheduled Heartbeat Daemon (/api/agent/watcher)
  if (req.method === "POST" && req.url === "/api/agent/watcher") {
    try {
      const {
        action = "status",
        botId = "bot_r1",
        botName = "R1",
        threadId = "thread_r1",
        intervalSec = 0
      } = await readJsonBody(req);

      const wt = ensureAgentWorktree(botId, botName);

      if (action === "start_watch") {
        if (agentWatchers.has(botId)) {
          try { agentWatchers.get(botId).close(); } catch {}
          agentWatchers.delete(botId);
        }
        let debounceTimer = null;
        const watcher = fs.watch(wt.codeDir, { recursive: true }, (eventType, filename) => {
          if (!filename || filename.startsWith(".")) return;
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            broadcastEvent("agent_heartbeat", {
              type: "file_change",
              trigger: "fs_watch",
              botId,
              botName,
              threadId,
              branch: wt.branch,
              filename,
              fileName: filename,
              eventType,
              timestamp: new Date().toISOString()
            });
          }, 900);
        });
        agentWatchers.set(botId, watcher);

        if (agentHeartbeats.has(botId)) {
          clearInterval(agentHeartbeats.get(botId));
          agentHeartbeats.delete(botId);
        }
        if (Number(intervalSec) >= 15) {
          const timer = setInterval(() => {
            broadcastEvent("agent_heartbeat", {
              type: "scheduled_heartbeat",
              trigger: "heartbeat",
              botId,
              botName,
              threadId,
              branch: wt.branch,
              intervalSec: Number(intervalSec),
              timestamp: new Date().toISOString()
            });
          }, Number(intervalSec) * 1000);
          agentHeartbeats.set(botId, timer);
        }

        return sendJson(res, 200, {
          ok: true,
          watching: true,
          botId,
          codeDir: wt.codeDir,
          intervalSec: Number(intervalSec) || 60,
          heartbeatSec: Number(intervalSec) || 60
        });
      }

      if (action === "stop_watch") {
        if (agentWatchers.has(botId)) {
          try { agentWatchers.get(botId).close(); } catch {}
          agentWatchers.delete(botId);
        }
        if (agentHeartbeats.has(botId)) {
          clearInterval(agentHeartbeats.get(botId));
          agentHeartbeats.delete(botId);
        }
        return sendJson(res, 200, { ok: true, watching: false, botId });
      }

      return sendJson(res, 200, {
        ok: true,
        watching: agentWatchers.has(botId),
        heartbeatActive: agentHeartbeats.has(botId),
        botId
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 2H. Vanaras Sandbox Lifecycle & Headless Web Verification (/api/agent/sandbox)
  if (req.method === "POST" && req.url === "/api/agent/sandbox") {
    try {
      const {
        action = "EnsureSandBox",
        botId = "bot_r1",
        botName = "R1",
        url = ""
      } = await readJsonBody(req);

      const wt = ensureAgentWorktree(botId, botName);

      if (action === "EnsureSandBox") {
        const snapshotRef = getHeadSha(wt.worktreePath);
        return sendJson(res, 200, {
          ok: true,
          action,
          sandboxId: `vanara-box-${sanitizeSlug(botId)}`,
          status: "ACTIVE",
          state: "ACTIVE",
          snapshotRef,
          branch: wt.branch,
          codeDir: wt.codeDir,
          assignedPort: getAgentAssignedPort(botId),
          files: listAgentCodeFiles(wt.codeDir)
        });
      }

      if (action === "HibernateSandBox") {
        const srv = agentDevServers.get(botId);
        if (srv && srv.proc && !srv.proc.killed) {
          try { srv.proc.kill("SIGTERM"); } catch {}
        }
        agentDevServers.delete(botId);
        if (agentWatchers.has(botId)) {
          try { agentWatchers.get(botId).close(); } catch {}
          agentWatchers.delete(botId);
        }
        const snapshotRef = getHeadSha(wt.worktreePath);
        return sendJson(res, 200, {
          ok: true,
          action,
          sandboxId: `vanara-box-${sanitizeSlug(botId)}`,
          status: "HIBERNATED",
          state: "HIBERNATED",
          snapshotRef,
          branch: wt.branch
        });
      }

      if (action === "RecreateSandBox") {
        const srv = agentDevServers.get(botId);
        if (srv && srv.proc && !srv.proc.killed) {
          try { srv.proc.kill("SIGTERM"); } catch {}
        }
        agentDevServers.delete(botId);
        fs.rmSync(wt.codeDir, { recursive: true, force: true });
        const freshWt = ensureAgentWorktree(botId, botName);
        const snapshotRef = getHeadSha(freshWt.worktreePath);
        return sendJson(res, 200, {
          ok: true,
          action,
          sandboxId: `vanara-box-${sanitizeSlug(botId)}`,
          status: "RECREATED",
          state: "RECREATED",
          snapshotRef,
          branch: freshWt.branch,
          codeDir: freshWt.codeDir,
          files: listAgentCodeFiles(freshWt.codeDir)
        });
      }

      if (action === "VerifyWebUrl") {
        const targetUrl = url || `http://localhost:${getAgentAssignedPort(botId)}`;
        const upstream = await fetch(targetUrl);
        const html = await upstream.text();
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const scriptCount = (html.match(/<script\b/gi) || []).length;
        const buttonCount = (html.match(/<button\b/gi) || []).length;
        return sendJson(res, 200, {
          ok: upstream.ok,
          action,
          url: targetUrl,
          status: upstream.status,
          title: titleMatch ? titleMatch[1].trim() : "(no <title>)",
          bytes: html.length,
          bodyBytes: html.length,
          scriptCount,
          buttonCount,
          snippet: html.replace(/\s+/g, " ").slice(0, 360)
        });
      }

      return sendJson(res, 400, { error: `Unknown sandbox action: ${action}` });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 3. Grounded Folder Inspection Endpoint (POST /api/workspace/context)
  if (req.method === "POST" && req.url === "/api/workspace/context") {
    try {
      const { mountPath, folderPath, botId, botName } = await readJsonBody(req);
      let targetDir = mountPath || folderPath || ROOT_DIR;
      if (botId) {
        const wt = ensureAgentWorktree(botId, botName);
        targetDir = wt.worktreePath;
      }
      const info = inspectMountedDirectory(targetDir);
      return sendJson(res, 200, info);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 4. Asynchronous Background Command / Tool Runner (POST /api/workspace/exec & /api/workspace/kill)
  if (req.method === "POST" && req.url === "/api/workspace/kill") {
    try {
      const { threadId, botId } = await readJsonBody(req);
      const killedJobs = [];
      for (const [jobId, job] of backgroundJobs.entries()) {
        if (job.status === "running" && job.proc && (!threadId || job.threadId === threadId || !botId || job.botId === botId)) {
          try { job.proc.kill("SIGTERM"); } catch {}
          job.status = "killed";
          killedJobs.push(jobId);
        }
      }
      if (botId && activeRunProcs.has(botId)) {
        try { activeRunProcs.get(botId).kill("SIGTERM"); } catch {}
        activeRunProcs.delete(botId);
        killedJobs.push(`run_${botId}`);
      }
      return sendJson(res, 200, { ok: true, killedCount: killedJobs.length, killedJobs });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (req.method === "POST" && req.url === "/api/workspace/exec") {
    try {
      const { command, cwd, threadId, botId, botName } = await readJsonBody(req);
      if (!command) return sendJson(res, 400, { error: "Missing command" });

      let targetCwd = cwd && fs.existsSync(cwd) ? cwd : ROOT_DIR;
      let branch = "main";
      if (botId) {
        const wt = ensureAgentWorktree(botId, botName || botId);
        targetCwd = wt.worktreePath;
        branch = wt.branch;
      }

      const jobId = "job_" + Date.now();

      broadcastEvent("job_started", { jobId, command, threadId, botId, botName, cwd: targetCwd, branch });

      const execOptions = {
        cwd: targetCwd,
        timeout: 25000,
        maxBuffer: 1024 * 512,
        ...(process.platform === "win32" ? { shell: "powershell.exe" } : {})
      };

      const proc = exec(command, execOptions, (error, stdout, stderr) => {
        const output = ((stdout || "") + (stderr ? `\n${stderr}` : "")).trim().slice(0, 4000);
        const exitCode = error ? (error.killed ? 130 : (error.code || 1)) : 0;
        backgroundJobs.set(jobId, { id: jobId, command, threadId, botId, botName, status: "done", exitCode, output });
        broadcastEvent("job_finished", {
          jobId,
          command,
          cwd: targetCwd,
          branch,
          exitCode,
          output: output || (exitCode === 130 ? "(Command stopped by user)" : "(Command completed with no output)"),
          threadId,
          botId,
          botName
        });
      });

      backgroundJobs.set(jobId, { id: jobId, command, threadId, botId, botName, status: "running", startedAt: Date.now(), proc });

      return sendJson(res, 200, { jobId, status: "started", cwd: targetCwd, branch });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 5. External Human Peer / CLI System Agent Message Injection
  if (req.method === "POST" && (req.url === "/api/room/post" || req.url === "/api/events/publish")) {
    try {
      const msg = await readJsonBody(req);
      broadcastEvent("room_message", msg);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  function normalizeOpenAIBaseUrl(rawBase = "http://192.168.68.102:1234/v1") {
    const trimmed = String(rawBase || "http://192.168.68.102:1234/v1").trim().replace(/\/+$/, "");
    if (!trimmed) return "http://192.168.68.102:1234/v1";
    if (trimmed.endsWith("/v1") || trimmed.endsWith("/chat/completions") || trimmed.endsWith("/models") || trimmed.includes("/v1/")) {
      return trimmed;
    }
    return `${trimmed}/v1`;
  }

  async function fetchWithLocalFallback(cleanBase, pathSuffix, init = {}, primaryTimeoutMs = 90000, parentSignal = null) {
    const candidates = [
      cleanBase,
      "http://192.168.68.102:1234/v1",
      "http://127.0.0.1:1234/v1",
      "http://localhost:1234/v1",
      "http://127.0.0.1:11434/v1"
    ];
    const seen = new Set();
    let lastError = null;
    let isFirst = true;
    for (const base of candidates) {
      const norm = normalizeOpenAIBaseUrl(base);
      if (seen.has(norm)) continue;
      seen.add(norm);
      const targetUrl = norm.endsWith(pathSuffix) ? norm : `${norm}${pathSuffix}`;
      const ctrl = new AbortController();
      const timeoutMs = isFirst ? primaryTimeoutMs : 2500;
      isFirst = false;
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      if (parentSignal) {
        if (parentSignal.aborted) {
          clearTimeout(timer);
          ctrl.abort();
        } else {
          parentSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
        }
      }
      try {
        const res = await fetch(targetUrl, { ...init, signal: ctrl.signal });
        clearTimeout(timer);
        if (res.ok) return res;
        lastError = new Error(`HTTP ${res.status} from ${targetUrl}`);
        if (norm === cleanBase && candidates.length === 1) return res;
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        if (parentSignal?.aborted) throw err;
      }
    }
    throw lastError || new Error("All local LLM endpoints unreachable");
  }

  // 6A. Real-Time Token & Thought Streaming Proxy (POST /api/llm/stream)
  if (req.method === "POST" && req.url === "/api/llm/stream") {
    const streamAbortCtrl = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        try { streamAbortCtrl.abort(); } catch {}
      }
    });
    try {
      const {
        provider = "local",
        baseUrl = "http://192.168.68.102:1234/v1",
        apiKey = "",
        model = "",
        messages = [],
        temperature = 0.7,
        max_tokens = 3500
      } = await readJsonBody(req);

      const cleanBase = normalizeOpenAIBaseUrl(baseUrl);
      const chatUrl = cleanBase.endsWith("/chat/completions") ? cleanBase : `${cleanBase}/chat/completions`;
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const reqInit = {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages, temperature, max_tokens, stream: true }),
        signal: streamAbortCtrl.signal
      };
      const upstream = provider === "local"
        ? await fetchWithLocalFallback(cleanBase, "/chat/completions", reqInit, 90000, streamAbortCtrl.signal)
        : await fetch(chatUrl, reqInit);

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => "");
        return sendJson(res, upstream.status || 502, { error: `Stream HTTP ${upstream.status}: ${errText}` });
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive"
      });

      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const dataStr = line.slice(5).trim();
          if (dataStr === "[DONE]") {
            res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
            continue;
          }
          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta || {};
            const token = delta.content || "";
            const reasoning = delta.reasoning_content || delta.reasoning || "";
            if (token || reasoning) {
              res.write(`data: ${JSON.stringify({ token, reasoning })}\n\n`);
            }
          } catch {}
        }
      }
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (e) {
      if (!res.headersSent) {
        sendJson(res, 502, { error: e.message });
      } else {
        res.end();
      }
    }
    return;
  }

  // 6B. Universal Multi-Provider LLM Chat Proxy (Local, OpenRouter, Gemini, OpenAI, Claude, Qwen)
  if (req.method === "POST" && req.url === "/api/llm/chat") {
    try {
      const {
        provider = "local",
        baseUrl = "http://192.168.68.102:1234/v1",
        apiKey = "",
        model = "",
        messages = [],
        temperature = 0.7,
        max_tokens = 3000
      } = await readJsonBody(req);

      const cleanBase = normalizeOpenAIBaseUrl(baseUrl);

      // Native Anthropic Messages API
      if (provider === "anthropic" || cleanBase.includes("api.anthropic.com")) {
        const systemMsg = messages.find(m => m.role === "system")?.content || "";
        const userMsgs = messages.filter(m => m.role !== "system").map(m => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content
        }));
        const endpoint = cleanBase.endsWith("/messages")
          ? cleanBase
          : `${cleanBase.replace(/\/v1$/, "")}/v1/messages`;

        const upstream = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: model || "claude-sonnet-4-20250514",
            max_tokens,
            temperature,
            system: systemMsg,
            messages: userMsgs
          })
        });

        const raw = await upstream.text();
        if (!upstream.ok) {
          return sendJson(res, upstream.status, { error: `Anthropic HTTP ${upstream.status}: ${raw}` });
        }
        const parsed = JSON.parse(raw);
        const textBlock = (parsed.content || []).find(b => b.type === "text")?.text || "";
        const thinkingBlock = (parsed.content || []).find(b => b.type === "thinking")?.thinking || "";
        return sendJson(res, 200, {
          choices: [{
            message: {
              role: "assistant",
              content: textBlock,
              reasoning_content: thinkingBlock
            }
          }],
          model: parsed.model
        });
      }

      // Native Google Gemini API
      if (provider === "gemini" && !cleanBase.includes("/openai")) {
        const geminiModel = model || "gemini-2.5-flash";
        const systemMsg = messages.find(m => m.role === "system")?.content || "";
        const contents = messages.filter(m => m.role !== "system").map(m => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }]
        }));
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const body = {
          contents,
          generationConfig: { temperature, maxOutputTokens: max_tokens }
        };
        if (systemMsg) {
          body.systemInstruction = { parts: [{ text: systemMsg }] };
        }
        const upstream = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const raw = await upstream.text();
        if (!upstream.ok) {
          return sendJson(res, upstream.status, { error: `Gemini HTTP ${upstream.status}: ${raw}` });
        }
        const parsed = JSON.parse(raw);
        const parts = parsed.candidates?.[0]?.content?.parts || [];
        const text = parts.filter(p => !p.thought).map(p => p.text || "").join("\n");
        const thought = parts.filter(p => p.thought).map(p => p.text || "").join("\n");
        return sendJson(res, 200, {
          choices: [{
            message: {
              role: "assistant",
              content: text,
              reasoning_content: thought
            }
          }],
          model: geminiModel
        });
      }

      // OpenAI-Compatible (Local LM Studio, Ollama, OpenRouter, OpenAI, Qwen)
      const chatUrl = cleanBase.endsWith("/chat/completions")
        ? cleanBase
        : `${cleanBase}/chat/completions`;

      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      if (provider === "openrouter" || cleanBase.includes("openrouter.ai")) {
        headers["HTTP-Referer"] = "http://localhost:3000";
        headers["X-Title"] = "Vanaras Desktop App";
      }

      const payload = { messages, temperature, max_tokens };
      if (model) payload.model = model;

      const reqInit = {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      };
      const upstream = provider === "local"
        ? await fetchWithLocalFallback(cleanBase, "/chat/completions", reqInit, 25000)
        : await fetch(chatUrl, reqInit);

      const raw = await upstream.text();
      if (!upstream.ok) {
        return sendJson(res, upstream.status, { error: `Upstream HTTP ${upstream.status}: ${raw}` });
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(raw);
    } catch (e) {
      sendJson(res, 502, { error: e.message || "Proxy request failed" });
    }
    return;
  }

  // 7. Universal Model Discovery
  if (req.method === "POST" && req.url === "/api/llm/models") {
    try {
      const { provider = "local", baseUrl = "http://192.168.68.102:1234/v1", apiKey = "" } = await readJsonBody(req);
      const cleanBase = normalizeOpenAIBaseUrl(baseUrl);

      if (provider === "gemini") {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
        const upstream = await fetch(endpoint);
        if (!upstream.ok) return sendJson(res, upstream.status, { error: `Gemini HTTP ${upstream.status}` });
        const data = await upstream.json();
        const models = (data.models || []).map(m => (m.name || "").replace(/^models\//, "")).filter(Boolean);
        return sendJson(res, 200, { models });
      }

      if (provider === "anthropic") {
        return sendJson(res, 200, {
          models: ["claude-opus-4-20250514", "claude-sonnet-4-20250514", "claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"]
        });
      }

      const modelsUrl = cleanBase.endsWith("/models") ? cleanBase : `${cleanBase}/models`;
      const headers = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const upstream = provider === "local"
        ? await fetchWithLocalFallback(cleanBase, "/models", { method: "GET", headers }, 2500)
        : await fetch(modelsUrl, { method: "GET", headers });
      if (!upstream.ok) return sendJson(res, upstream.status, { error: `Models HTTP ${upstream.status}` });
      const data = await upstream.json();
      const models = (data.data || []).map(m => m.id).filter(Boolean);
      return sendJson(res, 200, { models });
    } catch (e) {
      sendJson(res, 502, { error: e.message });
    }
    return;
  }

  // 8. Multi-File Project / Deliverable Save (Supports saving into Mounted Folder or vanaras/projects/)
  if (req.method === "POST" && req.url === "/api/save-project") {
    try {
      const { projectName, mountPath, files = [] } = await readJsonBody(req);
      if (!Array.isArray(files) || files.length === 0) {
        return sendJson(res, 400, { error: "Missing files array" });
      }
      const slug = (projectName || "workspace-output").replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
      const baseTarget = mountPath && fs.existsSync(mountPath)
        ? path.resolve(mountPath)
        : path.resolve(ROOT_DIR, "projects", slug);

      const savedPaths = [];
      for (const file of files) {
        const relName = (file.name || "artifact.md").replace(/^\/+/, "").replace(/\.\./g, "");
        const safePath = path.resolve(baseTarget, relName);
        if (!isPathInside(safePath, baseTarget)) continue;
        fs.mkdirSync(path.dirname(safePath), { recursive: true });
        fs.writeFileSync(safePath, file.content || "", "utf8");
        savedPaths.push(safePath);
      }
      return sendJson(res, 200, {
        success: true,
        projectDir: baseTarget,
        savedPaths
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Static files
  const reqPath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const targetFile = path.resolve(__dirname, "." + reqPath);

  if (isPathInside(targetFile, __dirname) && fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
    const ext = path.extname(targetFile).toLowerCase();
    let contentType = "text/html; charset=utf-8";
    if (ext === ".js" || ext === ".mjs") contentType = "application/javascript";
    else if (ext === ".css") contentType = "text/css";
    else if (ext === ".json") contentType = "application/json";
    else if (ext === ".png") contentType = "image/png";
    else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
    else if (ext === ".svg") contentType = "image/svg+xml";
    else if (ext === ".webp") contentType = "image/webp";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": ext === ".png" ? "public, max-age=86400" : "no-cache, no-store, must-revalidate"
    });
    fs.createReadStream(targetFile).pipe(res);
  } else {
    const indexPath = path.join(__dirname, "index.html");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate"
    });
    fs.createReadStream(indexPath).pipe(res);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Vanaras Desktop Engine listening at http://localhost:${PORT}`);
});

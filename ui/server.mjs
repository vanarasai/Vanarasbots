import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec, execFile, execFileSync, execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(ROOT_DIR, "..");
const WORKSPACE_FILE = path.join(__dirname, ".vanaras-workspace.json");
const KEYS_VAULT_FILE = path.join(__dirname, ".vanaras-keys.json");
const AGENTS_STATE_DIR = path.join(__dirname, ".vanaras-agents");
const WORKTREES_DIR = path.join(ROOT_DIR, ".worktrees");
const PORT = 3000;

// Ensure child processes (git, python3, node, cargo, ffmpeg) have full developer PATH when launched via Finder / Vanaras.app
{
  const home = process.env.HOME || "";
  const extraPaths = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    home ? path.join(home, ".cargo", "bin") : "",
    home ? path.join(home, ".local", "bin") : ""
  ].filter(Boolean);
  const currentPath = process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
  process.env.PATH = [...new Set([...extraPaths, ...currentPath.split(":")])].join(":");
}

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

function hasVenvPython(venvDir) {
  if (!venvDir) return false;
  try {
    return (
      fs.existsSync(path.join(venvDir, "bin", "python3")) ||
      fs.existsSync(path.join(venvDir, "bin", "python")) ||
      fs.existsSync(path.join(venvDir, "Scripts", "python.exe"))
    );
  } catch {
    return false;
  }
}

function resolveSharedVenvDir(cwd = "", worktreePath = "") {
  const candidates = [
    cwd ? path.join(cwd, ".venv") : "",
    worktreePath ? path.join(worktreePath, ".venv") : "",
    path.join(ROOT_DIR, ".venv"),
    path.join(WORKTREES_DIR, "bot_r1", ".venv"),
    path.join(WORKTREES_DIR, "bot_r1", "agent_workspace", "r1", ".venv")
  ].filter(Boolean);

  if (fs.existsSync(WORKTREES_DIR)) {
    try {
      for (const ent of fs.readdirSync(WORKTREES_DIR, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
        const wtDir = path.join(WORKTREES_DIR, ent.name);
        candidates.push(path.join(wtDir, ".venv"));
        const awDir = path.join(wtDir, "agent_workspace");
        if (fs.existsSync(awDir)) {
          for (const sub of fs.readdirSync(awDir, { withFileTypes: true })) {
            if (sub.isDirectory() && !sub.name.startsWith(".")) {
              candidates.push(path.join(awDir, sub.name, ".venv"));
            }
          }
        }
      }
    } catch {}
  }

  for (const cand of candidates) {
    if (hasVenvPython(cand)) {
      try {
        return fs.realpathSync(cand);
      } catch {
        return cand;
      }
    }
  }
  return "";
}

const RUNTIME_NODE_MODULES = path.join(ROOT_DIR, ".vanaras-runtime", "node_modules");

function ensureBuiltinExpressShim() {
  const expressDir = path.join(RUNTIME_NODE_MODULES, "express");
  const indexMjs = path.join(expressDir, "index.mjs");
  if (fs.existsSync(indexMjs)) return RUNTIME_NODE_MODULES;
  try {
    fs.mkdirSync(expressDir, { recursive: true });
    fs.writeFileSync(
      path.join(expressDir, "package.json"),
      JSON.stringify({ name: "express", version: "4.18.2", type: "module", main: "index.mjs", exports: "./index.mjs" }, null, 2),
      "utf8"
    );
    const shimSource = `import http from 'http';
import fs from 'fs';
import path from 'path';

function matchRoute(pattern, pathname) {
  if (pattern === pathname) return {};
  const patParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      params[patParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

function createExpressApp() {
  const routes = [];
  const middlewares = [];
  const errorHandlers = [];

  const app = (req, res) => {
    const parsedUrl = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    req.path = parsedUrl.pathname;
    req.query = Object.fromEntries(parsedUrl.searchParams.entries());
    req.params = {};

    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (obj) => {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      res.end(JSON.stringify(obj));
      return res;
    };
    res.send = (body) => {
      if (typeof body === 'object' && body !== null && !Buffer.isBuffer(body)) {
        return res.json(body);
      }
      if (!res.headersSent) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      res.end(body);
      return res;
    };

    const runErrorHandlers = (err) => {
      let eIdx = 0;
      const nextErr = (e) => {
        if (res.writableEnded) return;
        const eh = errorHandlers[eIdx++];
        if (!eh) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e?.message || 'Internal Server Error' }));
          return;
        }
        try {
          eh(e, req, res, nextErr);
        } catch (err2) {
          nextErr(err2);
        }
      };
      nextErr(err);
    };

    let mwIdx = 0;
    const runNextMiddleware = (err) => {
      if (err) return runErrorHandlers(err);
      if (res.writableEnded) return;
      const mw = middlewares[mwIdx++];
      if (mw) {
        if (mw.prefix && !req.path.startsWith(mw.prefix)) {
          return runNextMiddleware();
        }
        try {
          const origPath = req.path;
          if (mw.prefix && mw.prefix !== '/') {
            req.path = origPath.slice(mw.prefix.length) || '/';
          }
          const maybePromise = mw.fn(req, res, (e) => {
            req.path = origPath;
            runNextMiddleware(e);
          });
          if (maybePromise && typeof maybePromise.catch === 'function') {
            maybePromise.catch(runErrorHandlers);
          }
        } catch (e) {
          runErrorHandlers(e);
        }
        return;
      }

      for (const r of routes) {
        if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
        const params = matchRoute(r.pattern, req.path);
        if (params) {
          req.params = params;
          try {
            const out = r.handler(req, res, runErrorHandlers);
            if (out && typeof out.catch === 'function') {
              out.catch(runErrorHandlers);
            }
          } catch (e) {
            runErrorHandlers(e);
          }
          return;
        }
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found', path: req.path }));
    };

    runNextMiddleware();
  };

  app.use = (arg1, arg2) => {
    const prefix = typeof arg1 === 'string' ? arg1 : '';
    const fn = typeof arg1 === 'function' ? arg1 : arg2;
    if (typeof fn === 'function') {
      if (fn.length === 4) {
        errorHandlers.push(fn);
      } else {
        middlewares.push({ prefix, fn });
      }
    }
    return app;
  };
  for (const m of ['get', 'post', 'put', 'delete', 'patch']) {
    app[m] = (pattern, handler) => {
      routes.push({ method: m.toUpperCase(), pattern, handler });
      return app;
    };
  }
  app.listen = (port, hostOrCb, maybeCb) => {
    const cb = typeof hostOrCb === 'function' ? hostOrCb : maybeCb;
    const host = typeof hostOrCb === 'string' ? hostOrCb : '0.0.0.0';
    const srv = http.createServer(app);
    srv.listen(port, host, cb);
    return srv;
  };
  return app;
}

createExpressApp.json = () => (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  let raw = '';
  req.on('data', c => { raw += c.toString('utf8'); });
  req.on('end', () => {
    if (!raw.trim()) {
      req.body = {};
      return next();
    }
    try {
      req.body = JSON.parse(raw);
      next();
    } catch (e) {
      e.type = 'entity.parse.failed';
      next(e);
    }
  });
};

createExpressApp.static = (rootDir) => (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const rel = (req.path === '/' ? '/index.html' : req.path).replace(/^\\/+/, '');
  if (!rel || rel.includes('..')) return next();
  const full = path.resolve(rootDir, rel);
  if (!full.startsWith(path.resolve(rootDir)) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return next();
  }
  const ext = path.extname(full).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
};

export default createExpressApp;
`;
    fs.writeFileSync(indexMjs, shimSource, "utf8");
  } catch {}
  return RUNTIME_NODE_MODULES;
}

function ensureSharedVenvSymlinks(worktreePath = "", codeDir = "") {
  const sharedVenv = resolveSharedVenvDir(codeDir, worktreePath);
  const runtimeNm = ensureBuiltinExpressShim();
  const sharedNodeModules = fs.existsSync(path.join(ROOT_DIR, "node_modules"))
    ? path.join(ROOT_DIR, "node_modules")
    : runtimeNm;
  const uiSubDir = codeDir && fs.existsSync(path.join(codeDir, "ui")) ? path.join(codeDir, "ui") : "";
  const targetDirs = [ROOT_DIR, worktreePath, codeDir, uiSubDir].filter(d => d && fs.existsSync(d));
  for (const dir of targetDirs) {
    if (sharedVenv && dir !== uiSubDir) {
      const linkPath = path.join(dir, ".venv");
      try {
        if (!fs.existsSync(linkPath)) {
          fs.symlinkSync(sharedVenv, linkPath, "dir");
        }
      } catch {}
    }
    if (sharedNodeModules && dir !== ROOT_DIR) {
      const nmLink = path.join(dir, "node_modules");
      try {
        if (!fs.existsSync(nmLink)) {
          fs.symlinkSync(sharedNodeModules, nmLink, "dir");
        }
      } catch {}
    }
  }
  return sharedVenv;
}

function buildAgentExecEnv(cwd = "", worktreePath = "") {
  const sharedVenv = ensureSharedVenvSymlinks(worktreePath, cwd);
  const venvBin = sharedVenv
    ? (process.platform === "win32" ? path.join(sharedVenv, "Scripts") : path.join(sharedVenv, "bin"))
    : "";
  const currentPath = process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  const pathEntries = [
    venvBin,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...currentPath.split(path.delimiter)
  ].filter(Boolean);
  const pyPaths = [cwd, worktreePath, ROOT_DIR, process.env.PYTHONPATH || ""].filter(Boolean);
  const nodePaths = [RUNTIME_NODE_MODULES, path.join(ROOT_DIR, "node_modules"), process.env.NODE_PATH || ""].filter(Boolean);

  return {
    ...process.env,
    PATH: [...new Set(pathEntries)].join(path.delimiter),
    ...(sharedVenv ? { VIRTUAL_ENV: sharedVenv } : {}),
    PIP_BREAK_SYSTEM_PACKAGES: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONPATH: [...new Set(pyPaths)].join(path.delimiter),
    NODE_PATH: [...new Set(nodePaths)].join(path.delimiter)
  };
}

function spawnCommandAsync(command, { cwd, worktreePath = "", timeout = 15000, trackKey = null, onProgress = null } = {}) {
  return new Promise((resolve) => {
    const execEnv = buildAgentExecEnv(cwd, worktreePath);
    const proc = spawn("sh", ["-c", command], {
      cwd,
      env: execEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (trackKey) {
      activeRunProcs.set(trackKey, proc);
    }
    let stdout = "";
    let stderr = "";
    let finished = false;
    let lastEmitTs = 0;
    const emitProgressIfNeeded = (force = false) => {
      if (typeof onProgress !== "function") return;
      const now = Date.now();
      if (!force && now - lastEmitTs < 110) return;
      lastEmitTs = now;
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      try { onProgress(combined); } catch {}
    };
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { proc.kill("SIGTERM"); } catch {}
        if (trackKey) activeRunProcs.delete(trackKey);
        resolve({ exitCode: 124, output: `${stdout}\n${stderr}\n[Timed out after ${timeout}ms]`.trim(), timedOut: true });
      }
    }, timeout);
    proc.stdout.on("data", chunk => {
      if (stdout.length < 96000) stdout += chunk.toString("utf8");
      emitProgressIfNeeded(false);
    });
    proc.stderr.on("data", chunk => {
      if (stderr.length < 96000) stderr += chunk.toString("utf8");
      emitProgressIfNeeded(false);
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
      emitProgressIfNeeded(true);
      const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").slice(0, 6000);
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
  if (cleanedOutput.trim() === "*(Completed reasoning pass — see Internal Reasoning above)*") {
    cleanedOutput = "";
  }
  cleanedOutput = cleanedOutput.replace(/<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/gi, (_, t) => {
    if (t && t.trim()) thoughts.push(t.trim());
    return "";
  });
  const openIdx = cleanedOutput.search(/<(?:think|thinking)>/i);
  if (openIdx !== -1 && !/<\/(?:think|thinking)>/i.test(cleanedOutput.slice(openIdx))) {
    const rawThink = cleanedOutput.slice(openIdx).replace(/^<(?:think|thinking)>/i, "").trim();
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
  // the reply / ===FILE:=== / File 1: / [TOOL:...] blocks at the tail, split at the response boundary:
  if (!finalCleaned && combinedReasoning) {
    const transitionRx = /\n((?:@[a-zA-Z0-9_-]+\b|===FILE:\s*[^\n=]+===|===PATCH:\s*[^\n=]+===|(?:Final\s+)?Response:\s*\n|(?:Let me write (?:all )?the (?:actual )?(?:files|code) now[^\n]*\n+)|File\s+1\s*:\s*[^\n]+\n)[\s\S]*)$/i;
    const m = combinedReasoning.match(transitionRx);
    if (m && m.index !== undefined && m.index > 0) {
      finalCleaned = m[1]
        .replace(/^(?:Final\s+)?Response:\s*\n/i, "")
        .replace(/^Let me write (?:all )?the (?:actual )?(?:files|code) now[^\n]*\n+/i, "")
        .trim();
      combinedReasoning = combinedReasoning.slice(0, m.index).trim();
    } else if (rawOutput && !priorReasoning && !rawOutput.trim().startsWith("<think>") && !rawOutput.trim().startsWith("<thinking>")) {
      finalCleaned = rawOutput.trim();
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

function getAgentSkillFile(botId) {
  const slug = sanitizeSlug(botId, "bot");
  const dir = path.join(AGENTS_STATE_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "SKILL.md");
}

function defaultAgentSkillMarkdown(botId = "bot_r1", botName = "R1", role = "Systems Architect") {
  return `---
name: ${sanitizeSlug(botName || botId)}-skill
description: Operational SKILL.md playbook and domain standards for @${botName} (${role})
---

# @${botName} (${role}) — Agent Skill Playbook

## Core Responsibilities
- Deliver complete, runnable, syntax-verified code inside isolated worktree \`vanara/${sanitizeSlug(botName || botId)}\`.
- Never emit placeholder stubs, empty pass blocks, or synthetic test-tones when real synthesis is required.
- Use \`===FILE: <path>===\` for complete modules and \`===PATCH: <path>===\` for surgical edits.
`;
}

function loadAgentSkill(botId, botName = "", role = "") {
  try {
    const file = getAgentSkillFile(botId);
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, "utf8");
    }
    const seed = defaultAgentSkillMarkdown(botId, botName || botId.replace(/^bot_/, "").toUpperCase(), role);
    fs.writeFileSync(file, seed, "utf8");
    return seed;
  } catch {
    return "";
  }
}

function saveAgentSkill(botId, skillMarkdown = "") {
  try {
    const file = getAgentSkillFile(botId);
    fs.writeFileSync(file, String(skillMarkdown || ""), "utf8");
    return file;
  } catch {
    return "";
  }
}

function getAgentConfigFile(botId) {
  const slug = sanitizeSlug(botId, "bot");
  const dir = path.join(AGENTS_STATE_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "agent-config.json");
}

function loadAgentConfig(botId) {
  try {
    const file = getAgentConfigFile(botId);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {}
  return null;
}

function saveAgentConfig(botId, config = {}) {
  try {
    const file = getAgentConfigFile(botId);
    const prev = loadAgentConfig(botId) || {};
    const merged = { ...prev, ...config, botId, updatedAt: Date.now() };
    fs.writeFileSync(file, JSON.stringify(merged, null, 2), "utf8");
    return merged;
  } catch {
    return null;
  }
}

function discoverWorkspaceSkillFiles() {
  const found = [];
  const candidateRoots = [
    path.join(ROOT_DIR, ".agents", "skills"),
    path.join(ROOT_DIR, "skills"),
    path.join(REPO_ROOT, ".agents", "skills"),
    path.join(REPO_ROOT, "skills")
  ];
  const seenPaths = new Set();
  for (const base of candidateRoots) {
    if (!fs.existsSync(base)) continue;
    try {
      for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
        const skillPath = path.join(base, ent.name, "SKILL.md");
        if (fs.existsSync(skillPath) && !seenPaths.has(skillPath)) {
          seenPaths.add(skillPath);
          const content = fs.readFileSync(skillPath, "utf8").slice(0, 12000);
          found.push({
            id: ent.name,
            name: ent.name,
            path: skillPath,
            content
          });
        }
      }
    } catch {}
  }
  return found;
}

// ============================================================================
// PER-AGENT ISOLATED GIT WORKTREE & CODE WORKSPACE MANAGER (.worktrees/<botId>)
// ============================================================================
const LEGACY_TEMPLATE_FILES = new Set([
  "gguf_dump.py", "quant_architecture.md", "embedding_lookup.py",
  "lookup_table.rs", "calibrate_q3.py", "phone_rss_probe.py", "vanara_task.py",
  "solution.py", "calc.js"
]);

function ensureAgentWorktree(botId, botName, customWorkspacePath = "") {
  const botSlug = sanitizeSlug(botId, "bot");
  const effectiveName = (botName && (botName !== "R1" || botId === "bot_r1")) ? botName : (botId ? botId.replace(/^bot_/, "") : "r1");
  const nameSlug = sanitizeSlug(effectiveName, "vanara");
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
  } catch (err) {
    if (fs.existsSync(worktreePath) && !fs.existsSync(path.join(worktreePath, ".git"))) {
      try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    }
    throw err;
  }

  // Dedicated Code Workspace folder for this agent inside its isolated worktree (or custom path)
  const codeDir = customWorkspacePath && path.isAbsolute(customWorkspacePath)
    ? customWorkspacePath
    : path.join(worktreePath, "agent_workspace", nameSlug);
  fs.mkdirSync(codeDir, { recursive: true });
  ensureSharedVenvSymlinks(worktreePath, codeDir);

  // Remove any legacy default template files so workspaces start clean
  try {
    for (const tplName of LEGACY_TEMPLATE_FILES) {
      const p1 = path.join(codeDir, tplName);
      if (fs.existsSync(p1)) fs.unlinkSync(p1);
      const p2 = path.join(worktreePath, tplName);
      if (fs.existsSync(p2)) fs.unlinkSync(p2);
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
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "target" ||
        entry.name === "__pycache__" ||
        entry.name === "output" ||
        entry.name.startsWith("output_test") ||
        entry.name.startsWith("test_output") ||
        entry.name === "Vanaras.command" ||
        entry.name.startsWith("victory_audit_file") ||
        LEGACY_TEMPLATE_FILES.has(entry.name)
      ) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile() && results.length < 40) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size <= 256 * 1024 && !/\.(wav|mp3|ogg|m4a|mp4|webm|mov|png|jpg|jpeg|gif|webp|pyc|pyo)$/i.test(entry.name)) {
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

const RESERVED_ROOT_ENTRIES = new Set([
  "ui", "crates", "macos", "Vanaras.app", "agent_workspace", "projects",
  "target", "node_modules", "skills", "docs", ".git", ".gitignore",
  ".worktrees", ".vanaras-memory", ".DS_Store", "__pycache__", ".pytest_cache",
  "Cargo.toml", "Cargo.lock", "package.json", "package-lock.json",
  "README.md", "AGENTS.md", "CONTRIBUTING.md", "build-macos-app.sh", "run-windows.bat"
]);

const STARTER_BOILERPLATE_FILES = new Set([
  "gguf_dump.py", "quant_architecture.md", "embedding_lookup.py", "lookup_table.rs",
  "calibrate_q3.py", "phone_rss_probe.py", "main.py", "vanara_task.py", "notes.md", "health_check.py", "calc.js", "solution.py", "Vanaras.command"
]);

function isDeliverableRelPathAllowed(relPath, { allowAgentSubdirs = false } = {}) {
  const norm = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || norm.includes("..")) return false;
  const parts = norm.split("/");
  const top = parts[0];
  if (!top || top.startsWith(".")) return false;
  if (!allowAgentSubdirs && RESERVED_ROOT_ENTRIES.has(top)) return false;
  if (allowAgentSubdirs && RESERVED_ROOT_ENTRIES.has(top) && top !== "ui") return false;
  if (top.startsWith("output_test") || top.startsWith("test_output") || top === "tmp" || top === "temp") return false;
  if (STARTER_BOILERPLATE_FILES.has(norm) || STARTER_BOILERPLATE_FILES.has(parts[parts.length - 1])) return false;
  for (const seg of parts) {
    if (!seg || seg.startsWith(".") || seg === "__pycache__" || seg === "node_modules" || seg === "target" || seg === "agent_workspace" || seg.startsWith("output_test") || seg.startsWith("test_output")) {
      return false;
    }
  }
  const baseName = parts[parts.length - 1];
  if (/\.(pyc|pyo|log|tmp)$/i.test(baseName)) return false;
  if (/^(?:evil\.|test_llm101\.wav$|victory_audit_file)/i.test(baseName)) return false;
  return true;
}

function collectDeliverablesInDir(baseDir, { allowAgentSubdirs = false } = {}) {
  const found = new Map();
  function walk(currDir, relPrefix = "") {
    if (!fs.existsSync(currDir)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const top = relPath.split("/")[0];
      if ((!allowAgentSubdirs && RESERVED_ROOT_ENTRIES.has(top)) || (allowAgentSubdirs && RESERVED_ROOT_ENTRIES.has(top) && top !== "ui") || entry.name === "__pycache__" || entry.name === "node_modules" || entry.name === "target" || entry.name === "agent_workspace") {
        continue;
      }
      const absPath = path.join(currDir, entry.name);
      if (entry.isDirectory()) {
        walk(absPath, relPath);
      } else if (entry.isFile() && isDeliverableRelPathAllowed(relPath, { allowAgentSubdirs })) {
        try {
          const st = fs.statSync(absPath);
          if (st.size <= 50 * 1024 * 1024) {
            found.set(relPath, { absPath, mtimeMs: st.mtimeMs, size: st.size });
          }
        } catch {}
      }
    }
  }
  walk(baseDir);
  return found;
}

function copyIfNewer(srcAbs, srcMtimeMs, destAbs) {
  try {
    if (path.resolve(srcAbs) === path.resolve(destAbs)) return false;
    if (fs.existsSync(destAbs)) {
      const dstStat = fs.statSync(destAbs);
      if (dstStat.mtimeMs >= srcMtimeMs - 25 && dstStat.size === fs.statSync(srcAbs).size) {
        return false;
      }
      if (dstStat.mtimeMs > srcMtimeMs + 25) {
        return false;
      }
    }
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(srcAbs, destAbs);
    return true;
  } catch {
    return false;
  }
}

function recoverTruncatedWorkspaceFilesFromHistory(agentCodeDirs = []) {
  try {
    if (!fs.existsSync(WORKSPACE_FILE) || agentCodeDirs.length === 0) return;
    const raw = fs.readFileSync(WORKSPACE_FILE, "utf8");
    const state = JSON.parse(raw);
    const completeBlocks = new Map();
    const blockRx = /===FILE:\s*([^\n=]+)===\s*\n([\s\S]*?)===END_FILE===/gi;
    for (const t of state.threads || []) {
      for (const m of t.messages || []) {
        for (const field of ["text", "reasoning"]) {
          const str = String(m?.[field] || "");
          if (!str.includes("===FILE:")) continue;
          let match;
          while ((match = blockRx.exec(str)) !== null) {
            const rel = String(match[1] || "").trim().replace(/^['"`*]+|['"`*:]+$/g, "").replace(/^\/+/, "");
            const body = String(match[2] || "").replace(/^```[a-zA-Z0-9_.-]*\r?\n/, "").replace(/\r?\n```\s*$/, "").trim();
            if (rel && !rel.includes("..") && body.length > 60) {
              const prev = completeBlocks.get(rel);
              if (!prev || body.length >= prev.length) {
                completeBlocks.set(rel, body);
              }
            }
          }
        }
      }
    }
    for (const [rel, completeContent] of completeBlocks.entries()) {
      for (const codeDir of agentCodeDirs) {
        const dest = path.resolve(codeDir, rel);
        if (!isPathInside(dest, codeDir)) continue;
        if (fs.existsSync(dest)) {
          const cur = fs.readFileSync(dest, "utf8");
          if (cur.startsWith("```") || (cur.length < completeContent.length * 0.7 && rel.endsWith(".html") && !cur.includes("</html>"))) {
            fs.writeFileSync(dest, completeContent, "utf8");
          }
        }
      }
    }
  } catch {}
}

function syncWorktreeDeliverablesToMainRoot(wt, { syncSiblings = true } = {}) {
  const promotedToRoot = [];
  try {
    const candidateDirs = [];
    const agentCodeDirs = [];
    if (wt && wt.codeDir && fs.existsSync(wt.codeDir)) {
      candidateDirs.push(wt.codeDir);
      agentCodeDirs.push(wt.codeDir);
    }
    if (wt && wt.worktreePath && fs.existsSync(wt.worktreePath)) candidateDirs.push(wt.worktreePath);

    const siblingDirs = [];
    if (syncSiblings && fs.existsSync(WORKTREES_DIR)) {
      try {
        for (const ent of fs.readdirSync(WORKTREES_DIR, { withFileTypes: true })) {
          if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
          const sibWt = path.join(WORKTREES_DIR, ent.name);
          siblingDirs.push(sibWt);
          const awDir = path.join(sibWt, "agent_workspace");
          if (fs.existsSync(awDir)) {
            for (const sub of fs.readdirSync(awDir, { withFileTypes: true })) {
              if (sub.isDirectory() && !sub.name.startsWith(".")) {
                const subCode = path.join(awDir, sub.name);
                siblingDirs.push(subCode);
                agentCodeDirs.push(subCode);
              }
            }
          }
        }
      } catch {}
    }

    const uniqueCodeDirs = [...new Set(agentCodeDirs)];
    recoverTruncatedWorkspaceFilesFromHistory(uniqueCodeDirs);

    const allSourceDirs = [...new Set([...candidateDirs, ...siblingDirs])];
    const newestByRel = new Map();
    const newestInCodeDirs = new Map();

    for (const dir of allSourceDirs) {
      const isCodeDir = uniqueCodeDirs.includes(dir);
      const map = collectDeliverablesInDir(dir, { allowAgentSubdirs: isCodeDir });
      for (const [relPath, info] of map.entries()) {
        if (isCodeDir) {
          const prevCode = newestInCodeDirs.get(relPath);
          if (!prevCode || info.mtimeMs > prevCode.mtimeMs) {
            newestInCodeDirs.set(relPath, info);
          }
        }
        if (isDeliverableRelPathAllowed(relPath, { allowAgentSubdirs: false })) {
          const prev = newestByRel.get(relPath);
          if (!prev || info.mtimeMs > prev.mtimeMs) {
            newestByRel.set(relPath, info);
          }
        }
      }
    }

    for (const [relPath, info] of newestInCodeDirs.entries()) {
      for (const targetCodeDir of uniqueCodeDirs) {
        const destAbs = path.resolve(targetCodeDir, relPath);
        if (!isPathInside(destAbs, targetCodeDir)) continue;
        copyIfNewer(info.absPath, info.mtimeMs, destAbs);
      }
    }

    const allTargetDirs = [...new Set([ROOT_DIR, ...allSourceDirs])];
    for (const [relPath, info] of newestByRel.entries()) {
      for (const targetBase of allTargetDirs) {
        const destAbs = path.resolve(targetBase, relPath);
        if (!isPathInside(destAbs, targetBase)) continue;
        const copied = copyIfNewer(info.absPath, info.mtimeMs, destAbs);
        if (targetBase === ROOT_DIR && (copied || fs.existsSync(destAbs))) {
          promotedToRoot.push(relPath);
        }
      }
    }
  } catch {}
  return [...new Set(promotedToRoot)];
}

function syncAllWorktreesToMainRoot() {
  return syncWorktreeDeliverablesToMainRoot(null, { syncSiblings: true });
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
      env: process.env,
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

function loadLocalKeysVault() {
  try {
    if (fs.existsSync(KEYS_VAULT_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(KEYS_VAULT_FILE, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch (e) {
    console.warn("Could not read local keys vault:", e.message);
  }
  return { providers: {}, bots: {} };
}

function saveLocalKeysVault(vaultUpdate = {}) {
  try {
    const current = loadLocalKeysVault();
    const merged = {
      providers: { ...(current.providers || {}), ...(vaultUpdate.providers || {}) },
      bots: { ...(current.bots || {}), ...(vaultUpdate.bots || {}) },
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(KEYS_VAULT_FILE, JSON.stringify(merged, null, 2), { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(KEYS_VAULT_FILE, 0o600); } catch {}
    return merged;
  } catch (e) {
    console.warn("Could not write local keys vault:", e.message);
    return loadLocalKeysVault();
  }
}

function resolveVaultApiKey(provider = "", explicitKey = "", botId = "") {
  const trimmed = String(explicitKey || "").trim();
  if (trimmed) return trimmed;
  const vault = loadLocalKeysVault();
  if (botId && vault.bots && vault.bots[botId]) {
    return String(vault.bots[botId]).trim();
  }
  const prov = String(provider || "").toLowerCase();
  if (prov && vault.providers && vault.providers[prov]) {
    return String(vault.providers[prov]).trim();
  }
  if (prov === "openrouter" && process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  if ((prov === "openai") && process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if ((prov === "anthropic" || prov === "claude") && process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (prov === "gemini" && (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
    return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  }
  return "";
}

function loadWorkspaceDiskState() {
  try {
    if (fs.existsSync(WORKSPACE_FILE)) {
      const state = JSON.parse(fs.readFileSync(WORKSPACE_FILE, "utf8"));
      const vault = loadLocalKeysVault();
      if (state && Array.isArray(state.bots)) {
        state.bots.forEach(b => {
          if (!b.apiKey) {
            const restoredKey = (vault.bots && vault.bots[b.id]) || (vault.providers && vault.providers[b.provider]) || "";
            if (restoredKey) b.apiKey = restoredKey;
          }
        });
      }
      return state;
    }
  } catch (e) {
    console.warn("Could not read workspace file:", e.message);
  }
  return null;
}

function saveWorkspaceDiskState(state) {
  try {
    const sanitized = JSON.parse(JSON.stringify(state));
    const botKeys = {};
    const providerKeys = {};
    if (Array.isArray(sanitized.bots)) {
      sanitized.bots.forEach(b => {
        if (b.apiKey && String(b.apiKey).trim()) {
          const cleanKey = String(b.apiKey).trim();
          botKeys[b.id] = cleanKey;
          if (b.provider && b.provider !== "local") {
            providerKeys[String(b.provider).toLowerCase()] = cleanKey;
          }
        }
        delete b.apiKey;
        if (Array.isArray(b.memories)) {
          saveAgentMemory(b.id, b.memories);
        }
      });
    }
    if (Object.keys(botKeys).length > 0 || Object.keys(providerKeys).length > 0) {
      saveLocalKeysVault({ providers: providerKeys, bots: botKeys });
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
function inspectMountedDirectory(targetPath, codeDir = "") {
  const resolved = path.resolve(ROOT_DIR, targetPath || ".");
  if (!fs.existsSync(resolved)) {
    return { exists: false, path: resolved, summary: `Directory not found: ${resolved}` };
  }

  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(e => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "target" && !LEGACY_TEMPLATE_FILES.has(e.name))
      .slice(0, 35)
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name));

    const snippets = [];
    for (const candidate of ["Cargo.toml", "package.json", "README.md"]) {
      const p = path.join(resolved, candidate);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const content = fs.readFileSync(p, "utf8").slice(0, 600);
        snippets.push(`--- ${candidate} ---\n${content}`);
      }
    }

    // Include live source files from the agent's workspace so the agent never stops with "Let me first inspect the current state of my workspace"
    const wsDir = codeDir && fs.existsSync(codeDir) ? codeDir : resolved;
    const wsFiles = listAgentCodeFiles(wsDir)
      .filter(f => !/^test_r3_/i.test(f.name))
      .sort((a, b) => {
        const aIsTest = /(?:^|\/)test_|_test\./i.test(a.name) ? 1 : 0;
        const bIsTest = /(?:^|\/)test_|_test\./i.test(b.name) ? 1 : 0;
        if (aIsTest !== bIsTest) return aIsTest - bIsTest;
        const aIsCode = /\.(py|js|mjs|ts|rs|go|html)$/i.test(a.name) ? 0 : 1;
        const bIsCode = /\.(py|js|mjs|ts|rs|go|html)$/i.test(b.name) ? 0 : 1;
        if (aIsCode !== bIsCode) return aIsCode - bIsCode;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
    const wsDigest = wsFiles.length > 0
      ? `--- CURRENT WORKSPACE SOURCE FILES (ALREADY LOADED IN CONTEXT — DO NOT STOP TO INSPECT) ---\n` +
        wsFiles.slice(0, 16).map(f => {
          const raw = String(f.content || "");
          const body = raw.length > 18000
            ? `${raw.slice(0, 18000)}\n# [Context preview capped at 18000/${f.size}B — full file on disk is intact]`
            : raw;
          return `=== ${f.name} (${f.size}B) ===\n${body}`;
        }).join("\n\n")
      : "";

    const symbolMap = extractRepositorySymbolMap(wsFiles.length > 0 ? wsDir : resolved);
    const symbolDigest = symbolMap.length > 0
      ? `--- SYMBOL & ROUTE MAP ---\n` + symbolMap.map(s => `• ${s.file}: ${s.symbols.join(", ")}`).join("\n")
      : "";

    return {
      exists: true,
      path: resolved,
      entries,
      symbolMap,
      snippets,
      workspaceFiles: wsFiles.map(f => ({ name: f.name, size: f.size })),
      summary: `Mounted Path: ${resolved}\nTop-level files: ${entries.join(", ")}\n${wsDigest ? wsDigest + "\n\n" : ""}${symbolDigest ? symbolDigest + "\n\n" : ""}${snippets.join("\n\n")}`
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

  if (req.method === "GET" && (req.url === "/api/health" || req.url.startsWith("/api/health?"))) {
    return sendJson(res, 200, { ok: true, status: "running", pid: process.pid, port: PORT });
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

  // 2.1 Local Disk-Backed API Key Vault (GET & POST /api/settings/keys)
  if (req.method === "GET" && req.url === "/api/settings/keys") {
    const vault = loadLocalKeysVault();
    return sendJson(res, 200, { ok: true, providers: vault.providers || {}, bots: vault.bots || {}, updatedAt: vault.updatedAt || null });
  }

  if (req.method === "POST" && req.url === "/api/settings/keys") {
    try {
      const bodyObj = await readJsonBody(req);
      const saved = saveLocalKeysVault({
        providers: bodyObj.providers || {},
        bots: bodyObj.bots || {}
      });
      return sendJson(res, 200, { ok: true, providers: saved.providers || {}, bots: saved.bots || {}, updatedAt: saved.updatedAt });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 2A. Per-Agent Dedicated Code Workspace Endpoint (/api/agent/workspace)
  if (req.method === "POST" && req.url === "/api/agent/workspace") {
    try {
      const {
        botId = "bot_r1",
        botName = "",
        customWorkspacePath = "",
        action = "list",
        file = "",
        files = [],
        patches = [],
        fileName = "",
        filePath = "",
        command = "",
        title = "",
        body = ""
      } = await readJsonBody(req);

      const wt = ensureAgentWorktree(botId, botName, customWorkspacePath);
      const targetFile = file || fileName || filePath || "";

      if (action === "diff") {
        const fileFilter = String(targetFile || "").trim();
        let diffStr = "";
        const diffFiles = [];
        try {
          const diffArgs = ["diff", "HEAD"];
          if (fileFilter) {
            diffArgs.push("--", fileFilter);
          }
          const gitDiffOut = execFileSync("git", diffArgs, {
            cwd: wt.worktreePath,
            stdio: "pipe",
            timeout: 5000
          }).toString("utf8");
          if (gitDiffOut) {
            diffStr += gitDiffOut;
          }
        } catch {}

        try {
          const statusOut = execFileSync("git", ["status", "--porcelain"], {
            cwd: wt.worktreePath,
            stdio: "pipe",
            timeout: 5000
          }).toString("utf8");

          const statusLines = statusOut.split(/\r?\n/).filter(Boolean);
          for (const line of statusLines) {
            const statusCode = line.slice(0, 2).trim();
            const relFile = line.slice(3).trim();
            if (fileFilter && relFile !== fileFilter) continue;

            let fileStatus = "modified";
            if (statusCode === "??" || statusCode === "?") fileStatus = "untracked";
            else if (statusCode === "A") fileStatus = "added";
            else if (statusCode === "D") fileStatus = "deleted";
            else if (statusCode === "M") fileStatus = "modified";
            diffFiles.push({ file: relFile, status: fileStatus });

            if (statusCode === "??" || statusCode === "?") {
              const fullUntracked = path.resolve(wt.worktreePath, relFile);
              if (isPathInside(fullUntracked, wt.worktreePath) && fs.existsSync(fullUntracked) && fs.statSync(fullUntracked).isFile()) {
                const untrackedContent = fs.readFileSync(fullUntracked, "utf8");
                const uLines = untrackedContent.split(/\r?\n/);
                const uDiff = [
                  `diff --git a/${relFile} b/${relFile}`,
                  `new file mode 100644`,
                  `--- /dev/null`,
                  `+++ b/${relFile}`,
                  `@@ -0,0 +1,${uLines.length} @@`,
                  ...uLines.map(l => `+${l}`)
                ].join("\n") + "\n";
                diffStr += (diffStr ? "\n" : "") + uDiff;
              }
            }
          }
        } catch {}

        return sendJson(res, 200, {
          ok: true,
          action: "diff",
          botId,
          botName: wt.botName,
          branch: wt.branch,
          diff: diffStr,
          files: diffFiles
        });
      }

      if (action === "revert_file") {
        const cleanFile = String(targetFile || "").trim();
        if (!cleanFile) {
          return sendJson(res, 400, { ok: false, error: "Missing file parameter for revert_file" });
        }
        if (cleanFile.includes("..")) {
          return sendJson(res, 400, { ok: false, error: "Path traversal outside workspace blocked" });
        }
        const relPath = cleanFile.replace(/^\/+/, "");
        const targetInWt = path.resolve(wt.worktreePath, relPath);
        if (!isPathInside(targetInWt, wt.worktreePath)) {
          return sendJson(res, 400, { ok: false, error: "Path traversal outside workspace blocked" });
        }

        let isTracked = false;
        try {
          execFileSync("git", ["ls-files", "--error-unmatch", relPath], {
            cwd: wt.worktreePath,
            stdio: "pipe",
            timeout: 5000
          });
          isTracked = true;
        } catch {}

        if (isTracked) {
          try {
            execFileSync("git", ["checkout", "HEAD", "--", relPath], {
              cwd: wt.worktreePath,
              stdio: "pipe",
              timeout: 5000
            });
            const targetInCode = path.resolve(wt.codeDir, relPath);
            if (isPathInside(targetInCode, wt.codeDir) && fs.existsSync(targetInWt)) {
              try { fs.copyFileSync(targetInWt, targetInCode); } catch {}
            }
          } catch (checkoutErr) {
            return sendJson(res, 500, { ok: false, error: `Failed to checkout tracked file: ${checkoutErr.message}` });
          }
        } else {
          if (fs.existsSync(targetInWt) && fs.statSync(targetInWt).isFile()) {
            try { fs.unlinkSync(targetInWt); } catch {}
          }
          const targetInCode = path.resolve(wt.codeDir, relPath);
          if (isPathInside(targetInCode, wt.codeDir) && fs.existsSync(targetInCode) && fs.statSync(targetInCode).isFile()) {
            try { fs.unlinkSync(targetInCode); } catch {}
          }
          const targetInRoot = path.resolve(ROOT_DIR, relPath);
          if (isPathInside(targetInRoot, ROOT_DIR) && fs.existsSync(targetInRoot) && fs.statSync(targetInRoot).isFile()) {
            try { fs.unlinkSync(targetInRoot); } catch {}
          }
          if (fs.existsSync(WORKTREES_DIR)) {
            try {
              for (const ent of fs.readdirSync(WORKTREES_DIR, { withFileTypes: true })) {
                if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
                const sibWtPath = path.join(WORKTREES_DIR, ent.name);
                const sibTargetInWt = path.resolve(sibWtPath, relPath);
                if (isPathInside(sibTargetInWt, sibWtPath) && fs.existsSync(sibTargetInWt) && fs.statSync(sibTargetInWt).isFile()) {
                  try { fs.unlinkSync(sibTargetInWt); } catch {}
                }
                const sibAwDir = path.join(sibWtPath, "agent_workspace");
                if (fs.existsSync(sibAwDir)) {
                  try {
                    for (const sub of fs.readdirSync(sibAwDir, { withFileTypes: true })) {
                      if (sub.isDirectory() && !sub.name.startsWith(".")) {
                        const subCodeDir = path.join(sibAwDir, sub.name);
                        const subTarget = path.resolve(subCodeDir, relPath);
                        if (isPathInside(subTarget, subCodeDir) && fs.existsSync(subTarget) && fs.statSync(subTarget).isFile()) {
                          try { fs.unlinkSync(subTarget); } catch {}
                        }
                      }
                    }
                  } catch {}
                  const sibDirectAw = path.resolve(sibAwDir, relPath);
                  if (isPathInside(sibDirectAw, sibAwDir) && fs.existsSync(sibDirectAw) && fs.statSync(sibDirectAw).isFile()) {
                    try { fs.unlinkSync(sibDirectAw); } catch {}
                  }
                }
              }
            } catch {}
          }
          const rootAwDir = path.join(ROOT_DIR, "agent_workspace");
          if (fs.existsSync(rootAwDir)) {
            try {
              for (const sub of fs.readdirSync(rootAwDir, { withFileTypes: true })) {
                if (sub.isDirectory() && !sub.name.startsWith(".")) {
                  const subCodeDir = path.join(rootAwDir, sub.name);
                  const subTarget = path.resolve(subCodeDir, relPath);
                  if (isPathInside(subTarget, subCodeDir) && fs.existsSync(subTarget) && fs.statSync(subTarget).isFile()) {
                    try { fs.unlinkSync(subTarget); } catch {}
                  }
                }
              }
            } catch {}
          }
        }

        return sendJson(res, 200, {
          ok: true,
          action: "revert_file",
          botId,
          file: relPath,
          message: `Successfully reverted ${relPath}`
        });
      }

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
            if (isPathInside(destInCodeDir, wt.codeDir) && targetDest !== destInCodeDir) {
              try {
                fs.mkdirSync(path.dirname(destInCodeDir), { recursive: true });
                fs.writeFileSync(destInCodeDir, updatedContent, "utf8");
              } catch {}
            }
            const topSegment = cleanRel.split("/")[0];
            if (topSegment && !RESERVED_ROOT_ENTRIES.has(topSegment) && isPathInside(destInWorktree, wt.worktreePath) && targetDest !== destInWorktree) {
              try {
                fs.mkdirSync(path.dirname(destInWorktree), { recursive: true });
                fs.writeFileSync(destInWorktree, updatedContent, "utf8");
              } catch {}
            }
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
        const promotedToRoot = syncWorktreeDeliverablesToMainRoot(wt);
        const updatedWt = ensureAgentWorktree(botId, botName, customWorkspacePath);
        return sendJson(res, 200, {
          ...updatedWt,
          appliedPatches,
          promotedToRoot,
          autoCommitOut,
          files: listAgentCodeFiles(updatedWt.codeDir)
        });
      }

      if ((action === "save_files" || action === "save") && Array.isArray(files)) {
        const savedNames = [];
        for (const f of files) {
          if (!f || !f.name) continue;
          const cleanRel = String(f.name).replace(/^\/+/, "").replace(/\.\./g, "");
          const dest = path.resolve(wt.codeDir, cleanRel);
          if (isPathInside(dest, wt.codeDir)) {
            let cleanedContent = String(f.content ?? "")
              .replace(/^```[a-zA-Z0-9_.-]*\r?\n/, "")
              .replace(/\r?\n```\s*$/, "");
            if (fs.existsSync(dest) && fs.statSync(dest).isFile()) {
              const existingDisk = fs.readFileSync(dest, "utf8");
              const isHtml = /\.html?$/i.test(cleanRel);
              const existingCompleteHtml = isHtml && /<\/html>/i.test(existingDisk);
              const incomingIncompleteHtml = isHtml && !/<\/html>/i.test(cleanedContent);
              if (
                (f.complete === false && existingDisk.length > cleanedContent.length) ||
                (existingCompleteHtml && incomingIncompleteHtml && existingDisk.length > cleanedContent.length)
              ) {
                continue;
              }
            }
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, cleanedContent, "utf8");
            savedNames.push(cleanRel);
            const topSegment = cleanRel.split("/")[0];
            if (topSegment && !RESERVED_ROOT_ENTRIES.has(topSegment)) {
              const wtDest = path.resolve(wt.worktreePath, cleanRel);
              if (isPathInside(wtDest, wt.worktreePath)) {
                try {
                  fs.mkdirSync(path.dirname(wtDest), { recursive: true });
                  fs.writeFileSync(wtDest, cleanedContent, "utf8");
                } catch {}
              }
            }
          }
        }
        // Automatically stage & commit the agent's code changes onto its isolated branch (vanara/<bot>)
        let autoCommitOut = "";
        if (savedNames.length > 0) {
          const slug = wt.botName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
          const autoMsg = `feat(${slug}): update ${savedNames.join(", ")} in agent workspace`;
          autoCommitOut = safeGitCommit(wt.worktreePath, autoMsg, 5000);
        }
        const promotedToRoot = syncWorktreeDeliverablesToMainRoot(wt);
        const updatedWt = ensureAgentWorktree(botId, botName, customWorkspacePath);
        return sendJson(res, 200, {
          ...updatedWt,
          savedNames,
          promotedToRoot,
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
        const promotedToRoot = syncWorktreeDeliverablesToMainRoot(wt);
        const updatedWt = ensureAgentWorktree(botId, botName, customWorkspacePath);
        return sendJson(res, 200, {
          ...updatedWt,
          promotedToRoot,
          output,
          files: listAgentCodeFiles(updatedWt.codeDir)
        });
      }

      if (action === "merge_to_main") {
        const slug = wt.botName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        let output = "";
        const verifiedFiles = [];
        let promotedToRoot = [];
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

          // 3. Copy agent_workspace/<slug> into main ROOT_DIR/agent_workspace/<slug> AND promote all squad deliverables & generated outputs into ROOT_DIR
          const mainDest = path.resolve(ROOT_DIR, "agent_workspace", slug);
          fs.mkdirSync(mainDest, { recursive: true });
          fs.cpSync(wt.codeDir, mainDest, { recursive: true, force: true });
          promotedToRoot = syncAllWorktreesToMainRoot();
          try {
            execFileSync("git", ["add", `agent_workspace/${slug}`], { cwd: ROOT_DIR, stdio: "pipe", timeout: 4000 });
            execFileSync("git", ["commit", "-m", `feat(${slug}): merge ${wt.branch} workspace into main`], { cwd: ROOT_DIR, stdio: "pipe", timeout: 4000 });
          } catch {}
          const commitLog = execFileSync("git", ["log", "--oneline", "-n", "3"], {
            cwd: ROOT_DIR,
            stdio: "pipe",
            timeout: 4000
          }).toString("utf8").trim();
          const promoNote = promotedToRoot.length > 0 ? `[Synced to Main Root Folder (${ROOT_DIR}): ${promotedToRoot.join(", ")}]\n` : "";
          output = (verifiedFiles.length > 0 ? `[Pre-Merge Syntax Check: ${verifiedFiles.join(", ")}]\n` : "") + promoNote + commitLog;
        } catch (err) {
          output = `Pre-merge verification or git merge failed: ${err.message}`;
        }
        const updatedWt = ensureAgentWorktree(botId, botName, customWorkspacePath);
        return sendJson(res, 200, {
          ...updatedWt,
          verifiedFiles,
          promotedToRoot,
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
        const allCodeFiles = listAgentCodeFiles(wt.codeDir).filter(cf => !/^test_r3_/i.test(cf.name) || cf.name === cleanFile);
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
            const sharedVenv = resolveSharedVenvDir(wt.codeDir, wt.worktreePath);
            const pyBin = sharedVenv ? path.join(sharedVenv, "bin", "python3") : "python3";
            // Avoid hanging 15s if a script starts a blocking server loop (uvicorn.run / app.run / serve_forever)
            if (/\b(?:uvicorn\.run|app\.run|serve_forever)\s*\(/.test(src)) {
              runCmd = `"${pyBin}" -m py_compile "${cleanFile}" && echo "[Verified server entrypoint ${cleanFile} syntax & imports ready]"`;
            } else {
              runCmd = `"${pyBin}" "${cleanFile}"`;
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
        const promotedToRoot = syncWorktreeDeliverablesToMainRoot(wt);

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
          promotedToRoot,
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
          syncWorktreeDeliverablesToMainRoot(wt);
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

  // 2C-bis. Per-Agent SKILL.md, MCP & Harness Configuration Store (/api/agent/skill)
  if (req.method === "POST" && req.url === "/api/agent/skill") {
    try {
      const { botId = "bot_r1", botName = "R1", botRole = "", role = "", action = "get", skillMarkdown = "", agentConfig = null } = await readJsonBody(req);
      const effectiveRole = botRole || role;
      const templates = discoverWorkspaceSkillFiles();
      if (action === "set") {
        const savedPath = saveAgentSkill(botId, skillMarkdown);
        const savedConfig = agentConfig ? saveAgentConfig(botId, agentConfig) : loadAgentConfig(botId);
        return sendJson(res, 200, {
          ok: true,
          botId,
          skillFile: savedPath,
          configFile: getAgentConfigFile(botId),
          skillMarkdown: String(skillMarkdown || ""),
          agentConfig: savedConfig,
          templates
        });
      }
      const loaded = loadAgentSkill(botId, botName, effectiveRole);
      const loadedConfig = loadAgentConfig(botId);
      return sendJson(res, 200, {
        ok: true,
        botId,
        skillFile: getAgentSkillFile(botId),
        configFile: getAgentConfigFile(botId),
        skillMarkdown: loaded,
        agentConfig: loadedConfig,
        templates
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 2D. Per-Agent Tool & MCP Server Executor (/api/agent/tool)
  if (req.method === "POST" && req.url === "/api/agent/tool") {
    try {
      const {
        botId,
        botName,
        tool,
        action,
        args = {},
        toolName: requestedMcpToolName,
        toolArgs: requestedMcpToolArgs,
        filePath,
        content,
        mcpCommand,
        streamId = "",
        threadId = "",
        isRegex,
        path: pathParam,
        dir,
        directory
      } = await readJsonBody(req);
      const toolName = tool || action;
      const wt = ensureAgentWorktree(botId || "bot_r1", botName || "R1");
      const savedAgentCfg = loadAgentConfig(botId || "bot_r1") || {};
      const effectiveMcpCommand = String(mcpCommand || savedAgentCfg.mcpCommand || "").trim();

      if (toolName === "mcp_probe" && effectiveMcpCommand) {
        const mcpRes = await callStdioMcpServer({ commandLine: effectiveMcpCommand, cwd: wt.worktreePath, method: "tools/list" });
        const tools = mcpRes.result?.tools || [];
        return sendJson(res, 200, { ...mcpRes, tools });
      }

      if (toolName === "mcp_call" && effectiveMcpCommand) {
        const targetMcpTool = requestedMcpToolName || args.name || "";
        const targetMcpArgs = requestedMcpToolArgs || args.arguments || {};
        const mcpRes = await callStdioMcpServer({
          commandLine: effectiveMcpCommand,
          cwd: wt.worktreePath,
          method: "tools/call",
          params: { name: targetMcpTool, arguments: targetMcpArgs }
        });
        const contentItems = Array.isArray(mcpRes.result?.content)
          ? mcpRes.result.content.map(c => c.text || JSON.stringify(c)).join("\n")
          : "";
        const output = contentItems || (mcpRes.result ? JSON.stringify(mcpRes.result, null, 2) : "");
        return sendJson(res, 200, { ...mcpRes, output });
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

        const text = fs.readFileSync(existingTarget, "utf8").slice(0, 12000);
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
          } else if (isPathInside(rawInput, ROOT_DIR)) {
            rel = path.relative(ROOT_DIR, rawInput);
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
        const topSegment = cleanRel.split("/")[0];
        if (topSegment && !RESERVED_ROOT_ENTRIES.has(topSegment)) {
          const wtDest = path.resolve(wt.worktreePath, cleanRel);
          if (isPathInside(wtDest, wt.worktreePath)) {
            try {
              fs.mkdirSync(path.dirname(wtDest), { recursive: true });
              fs.writeFileSync(wtDest, bodyContent, "utf8");
            } catch {}
          }
        }
        const slug = (botName || botId).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        const promotedToRoot = syncWorktreeDeliverablesToMainRoot(wt);
        return sendJson(res, 200, {
          ok: true,
          bytesWritten: bodyContent.length,
          worktreePath: wt.worktreePath,
          codeDir: wt.codeDir,
          branch: wt.branch,
          promotedToRoot,
          output: `Wrote ${bodyContent.length} bytes to ${cleanRel} & synced to main root folder`
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
        const promotedToRoot = syncWorktreeDeliverablesToMainRoot(wt);
        return sendJson(res, 200, { ok: true, worktreePath: wt.worktreePath, branch: wt.branch, promotedToRoot, output: out });
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
            const codeFiles = listAgentCodeFiles(wt.codeDir).map(f => f.name);
            out = [
              `Branch: ${br.stdout.trim() || wt.branch} (${wt.codeDir})`,
              codeFiles.length > 0 ? `Workspace files: ${codeFiles.join(", ")}` : "",
              st.stdout.trim() || "(Clean worktree)"
            ].filter(Boolean).join("\n");
          }
        } catch (err) {
          out = err.message;
        }
        return sendJson(res, 200, { ok: true, worktreePath: wt.worktreePath, codeDir: wt.codeDir, branch: wt.branch, output: out || "(Clean worktree)" });
      }

      if (toolName === "shell_exec" || toolName === "shell") {
        const rawCmd = String(content || filePath || args.command || "").trim();
        const execCwd = fs.existsSync(wt.codeDir) ? wt.codeDir : wt.worktreePath;
        const sharedVenv = resolveSharedVenvDir(execCwd, wt.worktreePath);
        let cmdStr = rawCmd
          .replace(/\\\\\(/g, "\\(")
          .replace(/\\\\\)/g, "\\)");
        if (sharedVenv) {
          cmdStr = cmdStr.replace(/\/(?:opt\/homebrew|usr\/local)\/bin\/(python3|python|pip3|pip)\b/g, "$1");
        }
        if (!cmdStr) {
          return sendJson(res, 400, { ok: false, error: "Missing shell command" });
        }
        const execRes = await spawnCommandAsync(cmdStr, {
          cwd: execCwd,
          worktreePath: wt.worktreePath,
          timeout: 90000,
          trackKey: botId || "bot_r1",
          onProgress: (chunk, tailOutput) => {
            if (streamId) {
              broadcastEvent("tool_stream", {
                streamId,
                threadId,
                botId: botId || "bot_r1",
                botName: botName || "R1",
                command: cmdStr,
                cwd: execCwd,
                branch: wt.branch,
                chunk,
                output: tailOutput
              });
            }
          }
        });
        ensureSharedVenvSymlinks(wt.worktreePath, wt.codeDir);
        const promotedToRoot = syncWorktreeDeliverablesToMainRoot(wt);
        return sendJson(res, 200, {
          ok: execRes.exitCode === 0,
          exitCode: execRes.exitCode,
          cwd: execCwd,
          branch: wt.branch,
          promotedToRoot,
          output: (execRes.output || `(exit ${execRes.exitCode})`).slice(-6000)
        });
      }

      if (toolName === "grep_search") {
        const pattern = content !== undefined ? content : (args.pattern ?? args.query ?? args.content);
        if (pattern === undefined || pattern === null || String(pattern).length === 0) {
          return sendJson(res, 400, { ok: false, error: "Search pattern cannot be empty" });
        }
        const patternStr = String(pattern);
        const isRegexFlag = Boolean(isRegex || args.isRegex);
        let regexObj = null;
        if (isRegexFlag) {
          try {
            regexObj = new RegExp(patternStr);
          } catch (regErr) {
            return sendJson(res, 400, { ok: false, error: `Invalid regular expression: ${regErr.message}` });
          }
        }

        const rawSearchPath = String(pathParam || dir || directory || args.path || args.dir || filePath || "").trim();
        let targetSearchDir = wt.worktreePath;
        if (rawSearchPath) {
          if (rawSearchPath.includes("..")) {
            const probe = path.resolve(wt.worktreePath, rawSearchPath);
            if (!isPathInside(probe, wt.worktreePath) && !isPathInside(probe, ROOT_DIR)) {
              return sendJson(res, 400, { ok: false, error: `Path traversal outside workspace blocked: ${rawSearchPath}` });
            }
          }
          const resolvedSub = path.resolve(wt.worktreePath, rawSearchPath);
          if (!isPathInside(resolvedSub, wt.worktreePath) && !isPathInside(resolvedSub, ROOT_DIR)) {
            return sendJson(res, 400, { ok: false, error: `Path outside workspace blocked: ${rawSearchPath}` });
          }
          if (fs.existsSync(resolvedSub)) {
            targetSearchDir = resolvedSub;
          }
        }

        const matches = [];
        let usedGitGrep = false;
        try {
          const gitGrepArgs = ["grep", "-n", "-I", "--untracked"];
          if (isRegexFlag) gitGrepArgs.push("-E");
          else gitGrepArgs.push("-F");
          gitGrepArgs.push(patternStr);

          const gitGrepOut = execFileSync("git", gitGrepArgs, {
            cwd: targetSearchDir,
            stdio: "pipe",
            timeout: 8000
          }).toString("utf8");

          const lines = gitGrepOut.split(/\r?\n/).filter(Boolean);
          for (const l of lines) {
            const firstColon = l.indexOf(":");
            if (firstColon === -1) continue;
            const secondColon = l.indexOf(":", firstColon + 1);
            if (secondColon === -1) continue;
            const matchFile = l.slice(0, firstColon);
            const lineNum = parseInt(l.slice(firstColon + 1, secondColon), 10);
            const lineText = l.slice(secondColon + 1);
            matches.push({ file: matchFile, line: lineNum, text: lineText });
          }
          usedGitGrep = true;
        } catch (gitErr) {
          if (gitErr.status === 1) {
            usedGitGrep = true; // Git exit 1 means no matches
          }
        }

        if (!usedGitGrep) {
          const ignoreNames = new Set(["node_modules", ".git", ".venv", "target", "dist", ".cache"]);
          function walkDir(d, relPrefix = "") {
            if (matches.length >= 250) return;
            let entries = [];
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
            for (const ent of entries) {
              if (ignoreNames.has(ent.name) || ent.name.startsWith(".")) continue;
              const fullP = path.join(d, ent.name);
              const relP = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
              if (ent.isDirectory()) {
                walkDir(fullP, relP);
              } else if (ent.isFile()) {
                try {
                  const stat = fs.statSync(fullP);
                  if (stat.size > 1000000) continue;
                  const fileStr = fs.readFileSync(fullP, "utf8");
                  const fileLines = fileStr.split(/\r?\n/);
                  for (let i = 0; i < fileLines.length; i++) {
                    const lineContent = fileLines[i];
                    let hit = false;
                    if (isRegexFlag && regexObj) {
                      hit = regexObj.test(lineContent);
                    } else {
                      hit = lineContent.includes(patternStr);
                    }
                    if (hit) {
                      matches.push({ file: relP, line: i + 1, text: lineContent });
                      if (matches.length >= 250) break;
                    }
                  }
                } catch {}
              }
            }
          }
          walkDir(targetSearchDir);
        }

        const outputLines = matches.slice(0, 100).map(m => `${m.file}:${m.line}: ${m.text}`);
        const formattedOut = outputLines.length > 0 ? outputLines.join("\n") : "(no matches found)";

        return sendJson(res, 200, {
          ok: true,
          tool: "grep_search",
          matches,
          output: formattedOut
        });
      }

      if (toolName === "find_files") {
        const query = content !== undefined ? String(content) : (args.query || args.content || args.pattern || "");
        if (query.includes("..")) {
          return sendJson(res, 400, { ok: false, error: "Path traversal outside workspace blocked" });
        }

        let allFiles = [];
        try {
          const lsOut = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
            cwd: wt.worktreePath,
            stdio: "pipe",
            timeout: 5000
          }).toString("utf8");
          allFiles = lsOut.split(/\r?\n/).filter(Boolean);
        } catch {}

        if (allFiles.length === 0) {
          const ignoreNames = new Set(["node_modules", ".git", ".venv", "target", "dist", ".cache"]);
          function walk(d, prefix = "") {
            let entries = [];
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
            for (const ent of entries) {
              if (ignoreNames.has(ent.name) || ent.name.startsWith(".")) continue;
              const fullP = path.join(d, ent.name);
              const relP = prefix ? `${prefix}/${ent.name}` : ent.name;
              if (ent.isDirectory()) walk(fullP, relP);
              else if (ent.isFile()) allFiles.push(relP);
            }
          }
          walk(wt.worktreePath);
        }

        if (fs.existsSync(wt.codeDir)) {
          for (const cf of listAgentCodeFiles(wt.codeDir)) {
            const relInWt = path.relative(wt.worktreePath, path.join(wt.codeDir, cf.name));
            if (!allFiles.includes(cf.name) && !allFiles.includes(relInWt)) {
              allFiles.push(cf.name);
            }
          }
        }

        let filtered = [];
        if (!query.trim()) {
          filtered = allFiles;
        } else {
          const cleanQ = query.trim();
          const hasWildcard = cleanQ.includes("*") || cleanQ.includes("?");
          if (hasWildcard) {
            try {
              const globRx = new RegExp("^" + cleanQ.replace(/([.+^$[\]\\(){}|])/g, "\\$1").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
              filtered = allFiles.filter(f => globRx.test(f) || globRx.test(path.basename(f)));
            } catch {
              filtered = allFiles.filter(f => f.toLowerCase().includes(cleanQ.toLowerCase()));
            }
          } else {
            const lowerQ = cleanQ.toLowerCase();
            filtered = allFiles.filter(f => f.toLowerCase().includes(lowerQ));
          }
        }

        return sendJson(res, 200, {
          ok: true,
          tool: "find_files",
          files: filtered,
          output: filtered.length > 0 ? filtered.join("\n") : "(no files found)"
        });
      }

      return sendJson(res, 400, { error: `Unknown agent tool: ${toolName}` });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 2D-2. Host MCP Ecosystem Auto-Discovery (/api/mcp/discover)
  if ((req.method === "GET" || req.method === "POST") && req.url === "/api/mcp/discover") {
    try {
      const discovered = [];
      const home = os.homedir();

      function sanitizeServer(srv) {
        const clean = {
          name: String(srv.name || "mcp-server"),
          source: String(srv.source || "Local Config"),
          command: String(srv.command || ""),
          args: Array.isArray(srv.args) ? srv.args.map(a => {
            let s = String(a);
            s = s.replace(/sk-[a-zA-Z0-9_-]{10,}/gi, "***REDACTED***");
            s = s.replace(/ghp_[a-zA-Z0-9]{10,}/gi, "***REDACTED***");
            s = s.replace(/AIzaSy[a-zA-Z0-9_-]{10,}/gi, "***REDACTED***");
            return s;
          }) : [],
          env: {}
        };

        if (srv.env && typeof srv.env === "object") {
          for (const [key, val] of Object.entries(srv.env)) {
            const lowerKey = key.toLowerCase();
            const valStr = String(val ?? "");
            if (
              lowerKey.includes("key") ||
              lowerKey.includes("token") ||
              lowerKey.includes("secret") ||
              lowerKey.includes("password") ||
              lowerKey.includes("auth") ||
              /sk-[a-zA-Z0-9_-]+/i.test(valStr) ||
              /ghp_[a-zA-Z0-9]+/i.test(valStr) ||
              /AIzaSy[a-zA-Z0-9_-]+/i.test(valStr)
            ) {
              clean.env[key] = "***REDACTED***";
            } else {
              clean.env[key] = valStr;
            }
          }
        }
        return clean;
      }

      // 1. Cursor MCP: ~/.cursor/mcp.json
      const cursorPath = path.join(home, ".cursor", "mcp.json");
      if (fs.existsSync(cursorPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
          const servers = cfg.mcpServers || cfg.servers || {};
          for (const [name, def] of Object.entries(servers)) {
            if (def && typeof def === "object") {
              discovered.push(sanitizeServer({
                name,
                source: "Cursor",
                command: def.command || "",
                args: def.args || [],
                env: def.env || {}
              }));
            }
          }
        } catch {}
      }

      // 2. Claude Desktop & Claude Code
      const claudeDesktopPaths = [
        path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        path.join(home, ".config", "Claude", "claude_desktop_config.json"),
        path.join(home, ".claude.json")
      ];
      for (const cp of claudeDesktopPaths) {
        if (fs.existsSync(cp)) {
          try {
            const cfg = JSON.parse(fs.readFileSync(cp, "utf8"));
            const servers = cfg.mcpServers || cfg.servers || {};
            for (const [name, def] of Object.entries(servers)) {
              if (def && typeof def === "object") {
                if (!discovered.some(d => d.name === name)) {
                  discovered.push(sanitizeServer({
                    name,
                    source: "Claude",
                    command: def.command || "",
                    args: def.args || [],
                    env: def.env || {}
                  }));
                }
              }
            }
          } catch {}
        }
      }

      // 3. Google Antigravity: ~/.gemini/antigravity/mcp/
      const antigravityDir = path.join(home, ".gemini", "antigravity", "mcp");
      if (fs.existsSync(antigravityDir)) {
        try {
          const entries = fs.readdirSync(antigravityDir, { withFileTypes: true });
          for (const ent of entries) {
            if (ent.isDirectory() && !ent.name.startsWith(".")) {
              if (!discovered.some(d => d.name === ent.name)) {
                discovered.push(sanitizeServer({
                  name: ent.name,
                  source: "Google Antigravity",
                  command: "npx",
                  args: ["-y", `@modelcontextprotocol/server-${ent.name}`],
                  env: {}
                }));
              }
            }
          }
        } catch {}
      }

      // Fallback default options if none found
      if (discovered.length === 0) {
        discovered.push(
          sanitizeServer({
            name: "filesystem",
            source: "Default MCP",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", ROOT_DIR],
            env: {}
          }),
          sanitizeServer({
            name: "fetch",
            source: "Default MCP",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-fetch"],
            env: {}
          })
        );
      }

      return sendJson(res, 200, { ok: true, servers: discovered });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
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

      // 4. PreCompactRequest: structured context-window compaction & summarization
      if (hook === "PreCompactRequest") {
        const msgList = Array.isArray(messages) ? messages : [];
        const olderMessages = msgList.slice(0, Math.max(0, msgList.length - 6));
        const userGoals = [];
        const touchedFiles = new Set();
        const turnNotes = [];

        for (const m of olderMessages) {
          const rawText = String(m.text || "");
          if (m.senderType === "user") {
            const cleanGoal = rawText.replace(/\s+/g, " ").trim().slice(0, 220);
            if (cleanGoal && !userGoals.includes(cleanGoal)) userGoals.push(cleanGoal);
            continue;
          }
          if (m.senderType === "terminal") {
            const cmd = String(m.command || "").trim();
            if (cmd) turnNotes.push(`- [Terminal] ${cmd} (exit ${m.exitCode ?? 0})`);
            continue;
          }
          const fileRx = /===FILE:\s*([^\n=]+?)===|===PATCH:\s*([^\n=]+?)===/gi;
          let fm;
          while ((fm = fileRx.exec(rawText)) !== null) {
            const fName = (fm[1] || fm[2] || "").trim();
            if (fName) touchedFiles.add(fName);
          }
          const strippedCode = rawText
            .replace(/===FILE:\s*[^\n=]+===[\s\S]*?(?:===END_FILE===|$)/gi, "")
            .replace(/===PATCH:\s*[^\n=]+===[\s\S]*?(?:===END_PATCH===|$)/gi, "")
            .replace(/```[\s\S]*?```/g, "")
            .replace(/\s+/g, " ")
            .trim();
          const who = m.botId ? m.botId.replace(/^bot_/, "").toUpperCase() : "Agent";
          if (strippedCode) {
            turnNotes.push(`- ${who}: ${strippedCode.slice(0, 200)}`);
          }
        }

        const digestSections = [];
        if (userGoals.length > 0) {
          digestSections.push(`User Goals: ${userGoals.slice(-3).join(" | ")}`);
        }
        if (touchedFiles.size > 0) {
          digestSections.push(`Files Created/Updated: ${Array.from(touchedFiles).join(", ")}`);
        }
        if (turnNotes.length > 0) {
          digestSections.push(`Key Prior Turns:\n${turnNotes.slice(-10).join("\n")}`);
        }
        const compactDigest = digestSections.length > 0
          ? `[PreCompact Summary of ${olderMessages.length} earlier turns]\n${digestSections.join("\n")}`
          : "Context window is already compact.";
        broadcastEvent("agent_hook", { hook, botId, botName, compactedCount: olderMessages.length, timestamp });
        return sendJson(res, 200, {
          ok: true,
          hook,
          compactedCount: olderMessages.length,
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
        const promotedToRoot = syncWorktreeDeliverablesToMainRoot(wt);
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
          promotedToRoot,
          objects: files,
          locks
        };
        const manifestFile = path.join(storeDir, `${sanitizeSlug(botId)}-manifest.json`);
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
        return sendJson(res, 200, { ok: true, action, promotedToRoot, manifest });
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
      let codeDir = "";
      let worktreeInfo = null;
      if (botId) {
        const wt = ensureAgentWorktree(botId, botName);
        targetDir = wt.worktreePath;
        codeDir = wt.codeDir;
        worktreeInfo = wt;
      }
      const info = inspectMountedDirectory(targetDir, codeDir);
      if (worktreeInfo) info.worktree = worktreeInfo;
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

  async function resolveOpenRouterModelSlug(requestedModel, cleanBase, headers) {
    if (!requestedModel) return null;
    try {
      const modelsUrl = cleanBase.endsWith("/models") ? cleanBase : `${cleanBase}/models`;
      const res = await fetch(modelsUrl, { headers });
      if (!res.ok) return null;
      const data = await res.json();
      const ids = Array.isArray(data?.data) ? data.data.map(m => m.id).filter(Boolean) : [];
      if (ids.includes(requestedModel)) return requestedModel;
      // Strip trailing numeric version suffixes like -4-0 or -2025...
      const stripped = requestedModel.replace(/-[0-9]+(?:-[0-9]+)*$/, "");
      if (stripped !== requestedModel && ids.includes(stripped)) return stripped;
      const prefixMatches = ids.filter(id => id.startsWith(stripped));
      if (prefixMatches.length > 0) return prefixMatches[0];
      const vendor = requestedModel.split("/")[0];
      if (vendor) {
        const vendorMatches = ids.filter(id => id.startsWith(`${vendor}/`));
        if (vendorMatches.length > 0) return vendorMatches[0];
      }
    } catch {}
    return null;
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
        apiKey: rawApiKey = "",
        botId = "",
        model = "",
        messages = [],
        temperature = 0.7,
        max_tokens = 8192,
        enableReasoning = false
      } = await readJsonBody(req);
      const apiKey = resolveVaultApiKey(provider, rawApiKey, botId);
      if (rawApiKey && String(rawApiKey).trim() && provider !== "local") {
        saveLocalKeysVault({
          providers: { [String(provider).toLowerCase()]: String(rawApiKey).trim() },
          ...(botId ? { bots: { [botId]: String(rawApiKey).trim() } } : {})
        });
      }

      const effectiveBase = (provider === "openrouter" && (!baseUrl || baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost") || baseUrl.includes("192.168.")))
        ? "https://openrouter.ai/api/v1"
        : baseUrl;
      const cleanBase = normalizeOpenAIBaseUrl(effectiveBase);

      // If provider is native Anthropic or Gemini without OpenAI compatibility endpoint, delegate to non-stream or return 400 so client falls back to /api/llm/chat
      if (provider === "anthropic" || provider === "claude" || (provider === "gemini" && !cleanBase.includes("/openai"))) {
        return sendJson(res, 400, { error: "Use /api/llm/chat for native Anthropic/Gemini endpoints" });
      }

      const chatUrl = cleanBase.endsWith("/chat/completions") ? cleanBase : `${cleanBase}/chat/completions`;
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      if (provider === "openrouter" || cleanBase.includes("openrouter.ai")) {
        headers["HTTP-Referer"] = "http://localhost:3000";
        headers["X-Title"] = "Vanaras Desktop App";
      }

      let activeModel = model;
      const buildStreamBody = (targetModel, reasoningCfg) => {
        const b = { model: targetModel, messages, temperature, max_tokens, stream: true };
        if (reasoningCfg) b.reasoning = reasoningCfg;
        if (!enableReasoning && provider === "local") {
          b.chat_template_kwargs = { enable_thinking: false };
        }
        return JSON.stringify(b);
      };

      const defaultReasoningCfg = enableReasoning ? undefined : { enabled: false };
      const reqInit = {
        method: "POST",
        headers,
        body: buildStreamBody(activeModel, defaultReasoningCfg),
        signal: streamAbortCtrl.signal
      };
      let upstream = provider === "local"
        ? await fetchWithLocalFallback(cleanBase, "/chat/completions", reqInit, 90000, streamAbortCtrl.signal)
        : await fetch(chatUrl, reqInit);

      if (!upstream.ok && upstream.status === 400) {
        let firstErrText = await upstream.text().catch(() => "");
        if ((provider === "openrouter" || cleanBase.includes("openrouter.ai")) && /not a valid model ID/i.test(firstErrText)) {
          const fallbackModel = await resolveOpenRouterModelSlug(activeModel, cleanBase, headers);
          if (fallbackModel && fallbackModel !== activeModel) {
            activeModel = fallbackModel;
            upstream = await fetch(chatUrl, {
              ...reqInit,
              body: buildStreamBody(activeModel, defaultReasoningCfg)
            });
            if (!upstream.ok) firstErrText = await upstream.text().catch(() => "");
          }
        }
        if (!upstream.ok && /reasoning/i.test(firstErrText)) {
          upstream = await fetch(chatUrl, {
            ...reqInit,
            body: buildStreamBody(activeModel, { effort: "low" })
          });
          if (!upstream.ok) {
            upstream = await fetch(chatUrl, {
              ...reqInit,
              body: buildStreamBody(activeModel, undefined)
            });
          }
        } else if (!upstream.ok) {
          return sendJson(res, 400, { error: `Stream HTTP 400: ${firstErrText}` });
        }
      }

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
      let totalContent = "";
      let totalReasoning = "";
      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        let abortReasoningRunaway = false;
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const dataStr = line.slice(5).trim();
          if (dataStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.error) {
              res.write(`data: ${JSON.stringify({ error: parsed.error.message || JSON.stringify(parsed.error) })}\n\n`);
              continue;
            }
            const delta = parsed.choices?.[0]?.delta || {};
            const token = delta.content || "";
            const reasoning = delta.reasoning_content || delta.reasoning || "";
            if (token || reasoning) {
              totalContent += token;
              totalReasoning += reasoning;
              res.write(`data: ${JSON.stringify({ token, reasoning })}\n\n`);
              if (!enableReasoning && !totalContent.trim() && totalReasoning.length > 1600) {
                abortReasoningRunaway = true;
                break;
              }
            }
          } catch {}
        }
        if (abortReasoningRunaway) break;
      }

      const visibleOutsideThink = totalContent
        .replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, "")
        .replace(/<(?:think|thinking)>[\s\S]*$/gi, "")
        .trim();

      if (!visibleOutsideThink && (totalReasoning.trim() || totalContent.trim()) && !streamAbortCtrl.signal.aborted) {
        try {
          const followUpMessages = [
            ...messages,
            {
              role: "user",
              content: "You spent your turn in internal reasoning without writing the visible response. Output the direct visible response, [TOOL: ...] actions, or ===FILE: ...=== blocks now with zero <think> tags."
            }
          ];
          const followRes = await fetch(chatUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: activeModel,
              messages: followUpMessages,
              temperature,
              max_tokens,
              stream: false,
              reasoning: { enabled: false }
            }),
            signal: streamAbortCtrl.signal
          });
          if (followRes.ok) {
            const followData = await followRes.json();
            const followText = (followData?.choices?.[0]?.message?.content || "").trim();
            if (followText) {
              res.write(`data: ${JSON.stringify({ token: followText, reasoning: "" })}\n\n`);
            }
          }
        } catch {}
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
        apiKey: rawApiKey = "",
        botId = "",
        model = "",
        messages = [],
        temperature = 0.7,
        max_tokens = 8192,
        enableReasoning = false
      } = await readJsonBody(req);
      const apiKey = resolveVaultApiKey(provider, rawApiKey, botId);
      if (rawApiKey && String(rawApiKey).trim() && provider !== "local") {
        saveLocalKeysVault({
          providers: { [String(provider).toLowerCase()]: String(rawApiKey).trim() },
          ...(botId ? { bots: { [botId]: String(rawApiKey).trim() } } : {})
        });
      }

      const effectiveBase = (provider === "openrouter" && (!baseUrl || baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost") || baseUrl.includes("192.168.")))
        ? "https://openrouter.ai/api/v1"
        : baseUrl;
      const cleanBase = normalizeOpenAIBaseUrl(effectiveBase);

      // Native Anthropic Messages API
      if (provider === "anthropic" || provider === "claude" || cleanBase.includes("api.anthropic.com")) {
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
      if (!enableReasoning) {
        payload.reasoning = { enabled: false };
        if (provider === "local") {
          payload.chat_template_kwargs = { enable_thinking: false };
        }
      }

      const reqInit = {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      };
      let upstream = provider === "local"
        ? await fetchWithLocalFallback(cleanBase, "/chat/completions", reqInit, 25000)
        : await fetch(chatUrl, reqInit);

      let raw = await upstream.text();
      if (!upstream.ok && upstream.status === 400) {
        if ((provider === "openrouter" || cleanBase.includes("openrouter.ai")) && /not a valid model ID/i.test(raw)) {
          const fallbackModel = await resolveOpenRouterModelSlug(model, cleanBase, headers);
          if (fallbackModel && fallbackModel !== model) {
            payload.model = fallbackModel;
            upstream = await fetch(chatUrl, {
              ...reqInit,
              body: JSON.stringify(payload)
            });
            raw = await upstream.text();
          }
        }
        if (!upstream.ok && /reasoning/i.test(raw)) {
          const retryPayload = { ...payload };
          delete retryPayload.reasoning;
          upstream = await fetch(chatUrl, {
            ...reqInit,
            body: JSON.stringify(retryPayload)
          });
          raw = await upstream.text();
        }
      }
      if (!upstream.ok) {
        return sendJson(res, upstream.status, { error: `Upstream HTTP ${upstream.status}: ${raw}` });
      }
      try {
        const parsedChat = JSON.parse(raw);
        const msg = parsedChat?.choices?.[0]?.message;
        const rawContent = String(msg?.content || "");
        const visibleText = rawContent
          .replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, "")
          .replace(/<(?:think|thinking)>[\s\S]*$/gi, "")
          .trim();
        const rawReason = String(msg?.reasoning_content || msg?.reasoning || "").trim();
        if (!visibleText && (rawReason || rawContent) && msg) {
          const followRes = await fetch(chatUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({
              ...payload,
              reasoning: { enabled: false },
              messages: [
                ...messages,
                {
                  role: "user",
                  content: "Output your direct visible response, [TOOL: ...] actions, or ===FILE: ...=== blocks now without <think> tags."
                }
              ]
            })
          });
          if (followRes.ok) {
            const followData = await followRes.json();
            const followContent = String(followData?.choices?.[0]?.message?.content || "").trim();
            if (followContent) {
              msg.content = followContent;
              raw = JSON.stringify(parsedChat);
            }
          }
        }
      } catch {}
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
      const { provider = "local", baseUrl = "http://192.168.68.102:1234/v1", apiKey: rawApiKey = "", botId = "" } = await readJsonBody(req);
      const apiKey = resolveVaultApiKey(provider, rawApiKey, botId);
      if (rawApiKey && String(rawApiKey).trim() && provider !== "local") {
        saveLocalKeysVault({
          providers: { [String(provider).toLowerCase()]: String(rawApiKey).trim() },
          ...(botId ? { bots: { [botId]: String(rawApiKey).trim() } } : {})
        });
      }
      const effectiveBase = (provider === "openrouter" && (!baseUrl || baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost") || baseUrl.includes("192.168.")))
        ? "https://openrouter.ai/api/v1"
        : baseUrl;
      const cleanBase = normalizeOpenAIBaseUrl(effectiveBase);

      if (provider === "gemini") {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
        const upstream = await fetch(endpoint);
        if (!upstream.ok) return sendJson(res, upstream.status, { error: `Gemini HTTP ${upstream.status}` });
        const data = await upstream.json();
        const models = (data.models || []).map(m => (m.name || "").replace(/^models\//, "")).filter(Boolean);
        return sendJson(res, 200, { models });
      }

      if (provider === "anthropic" || provider === "claude") {
        return sendJson(res, 200, {
          models: ["claude-opus-4-20250514", "claude-sonnet-4-20250514", "claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"]
        });
      }

      const modelsUrl = cleanBase.endsWith("/models") ? cleanBase : `${cleanBase}/models`;
      const headers = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      if (provider === "openrouter" || cleanBase.includes("openrouter.ai")) {
        headers["HTTP-Referer"] = "http://localhost:3000";
        headers["X-Title"] = "Vanaras Desktop App";
        if (apiKey) {
          const authCheck = await fetch("https://openrouter.ai/api/v1/auth/key", {
            method: "GET",
            headers
          }).catch(() => null);
          if (authCheck && (authCheck.status === 401 || authCheck.status === 403)) {
            return sendJson(res, 401, { error: "Invalid OpenRouter API Key (401 Unauthorized)" });
          }
        }
      }

      const upstream = provider === "local"
        ? await fetchWithLocalFallback(cleanBase, "/models", { method: "GET", headers }, 2500)
        : await fetch(modelsUrl, { method: "GET", headers });
      if (!upstream.ok) return sendJson(res, upstream.status, { error: `Models HTTP ${upstream.status}` });
      const data = await upstream.json();
      let models = (data.data || []).map(m => m.id).filter(Boolean);
      if (provider === "openrouter" || cleanBase.includes("openrouter.ai")) {
        models = models.filter(id => !id.startsWith("~"));
      }
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

  // 10. Workspace Media & Webpage Streaming Endpoint (GET/HEAD /api/workspace/media?path=...)
  if ((req.method === "GET" || req.method === "HEAD") && req.url.startsWith("/api/workspace/media")) {
    try {
      const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
      let rawPath = decodeURIComponent(parsedUrl.searchParams.get("path") || "").trim();
      const botId = parsedUrl.searchParams.get("botId") || "";
      const forceDownload = parsedUrl.searchParams.get("download") === "1";

      rawPath = rawPath.replace(/^file:\/\//i, "").trim();
      if (!rawPath || rawPath.includes("..")) {
        return sendJson(res, 400, { ok: false, error: "Invalid media path" });
      }

      const candidateFiles = [];
      const addCandidate = (p) => {
        try {
          const resolved = path.resolve(p);
          if ((isPathInside(resolved, ROOT_DIR) || isPathInside(resolved, WORKTREES_DIR)) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            candidateFiles.push({ path: resolved, mtimeMs: fs.statSync(resolved).mtimeMs });
          }
        } catch {}
      };

      if (path.isAbsolute(rawPath)) {
        addCandidate(rawPath);
      }

      const cleanRel = rawPath.replace(/^\/+/, "");
      addCandidate(path.join(ROOT_DIR, cleanRel));
      addCandidate(path.join(ROOT_DIR, "output", path.basename(cleanRel)));
      addCandidate(path.join(ROOT_DIR, "output_test", path.basename(cleanRel)));

      if (botId) {
        try {
          const wt = ensureAgentWorktree(botId, botId.replace(/^bot_/, "").toUpperCase());
          addCandidate(path.join(wt.codeDir, cleanRel));
          addCandidate(path.join(wt.worktreePath, cleanRel));
          addCandidate(path.join(wt.codeDir, "output", path.basename(cleanRel)));
          addCandidate(path.join(wt.worktreePath, "output", path.basename(cleanRel)));
        } catch {}
      }

      if (fs.existsSync(WORKTREES_DIR)) {
        try {
          for (const ent of fs.readdirSync(WORKTREES_DIR, { withFileTypes: true })) {
            if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
            const sibWt = path.join(WORKTREES_DIR, ent.name);
            addCandidate(path.join(sibWt, cleanRel));
            addCandidate(path.join(sibWt, "output", path.basename(cleanRel)));
            addCandidate(path.join(sibWt, "output_test", path.basename(cleanRel)));
            const awDir = path.join(sibWt, "agent_workspace");
            if (fs.existsSync(awDir)) {
              for (const sub of fs.readdirSync(awDir, { withFileTypes: true })) {
                if (sub.isDirectory() && !sub.name.startsWith(".")) {
                  const subDir = path.join(awDir, sub.name);
                  addCandidate(path.join(subDir, cleanRel));
                  addCandidate(path.join(subDir, "output", path.basename(cleanRel)));
                  addCandidate(path.join(subDir, "output_test", path.basename(cleanRel)));
                }
              }
            }
          }
        } catch {}
      }

      if (candidateFiles.length === 0) {
        return sendJson(res, 404, { ok: false, error: `Media file not found: ${rawPath}` });
      }

      candidateFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const chosenPath = candidateFiles[0].path;
      const stat = fs.statSync(chosenPath);
      const ext = path.extname(chosenPath).toLowerCase();

      const mimeMap = {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".ogg": "audio/ogg",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".flac": "audio/flac",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".html": "text/html; charset=utf-8",
        ".htm": "text/html; charset=utf-8",
        ".pdf": "application/pdf",
        ".json": "application/json; charset=utf-8",
        ".txt": "text/plain; charset=utf-8"
      };
      const contentType = mimeMap[ext] || "application/octet-stream";
      const baseHeaders = {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache"
      };
      if (forceDownload) {
        baseHeaders["Content-Disposition"] = `attachment; filename="${path.basename(chosenPath).replace(/"/g, "")}"`;
      }

      const rangeHeader = req.headers.range;
      if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader)) {
        const parts = rangeHeader.replace(/bytes=/, "").split("-");
        const start = parts[0] ? parseInt(parts[0], 10) : 0;
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        if (start >= stat.size || end >= stat.size || start > end) {
          res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          ...baseHeaders,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Content-Length": end - start + 1
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        fs.createReadStream(chosenPath, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        ...baseHeaders,
        "Content-Length": stat.size
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(chosenPath).pipe(res);
      return;
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // 10B. Live Agent Webpage Preview & Auto-Boot Proxy (GET /api/workspace/web-preview?url=...)
  if (req.method === "GET" && req.url.startsWith("/api/workspace/web-preview")) {
    try {
      const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
      const rawUrl = decodeURIComponent(parsedUrl.searchParams.get("url") || "").trim();
      const botId = parsedUrl.searchParams.get("botId") || "bot_r1";
      let targetUrlObj = null;
      try {
        targetUrlObj = new URL(rawUrl);
      } catch {
        return sendJson(res, 400, { ok: false, error: "Invalid preview URL" });
      }
      const targetPort = Number(targetUrlObj.port || 80);
      if (targetPort && targetPort !== Number(PORT)) {
        await ensureAgentPortServerRunning(targetPort, botId);
      }
      res.writeHead(302, {
        "Location": targetUrlObj.toString(),
        "Cache-Control": "no-cache"
      });
      res.end();
      return;
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
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

const managedAgentPortProcesses = new Map();

async function isLocalPortListening(port) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 700);
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.status > 0;
  } catch {
    return false;
  }
}

async function ensureAgentPortServerRunning(port, preferredBotId = "bot_r1") {
  if (!port || Number(port) === Number(PORT)) return false;
  if (await isLocalPortListening(port)) return true;

  const candidateScripts = [];
  const checkDirForServer = (dir) => {
    if (!dir || !fs.existsSync(dir)) return;
    for (const rel of ["ui/server.mjs", "ui/server.js", "server.mjs", "server.js"]) {
      const p = path.join(dir, rel);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        try {
          const src = fs.readFileSync(p, "utf8");
          if (src.includes(String(port)) || rel.startsWith("ui/")) {
            candidateScripts.push({ scriptPath: p, cwd: path.dirname(p) });
          }
        } catch {}
      }
    }
  };

  if (preferredBotId) {
    try {
      const wt = ensureAgentWorktree(preferredBotId, preferredBotId.replace(/^bot_/, "").toUpperCase());
      checkDirForServer(wt.codeDir);
      checkDirForServer(wt.worktreePath);
    } catch {}
  }
  for (const bId of ["bot_r1", "bot_r2", "bot_r3"]) {
    try {
      const wt = ensureAgentWorktree(bId, bId.replace(/^bot_/, "").toUpperCase());
      checkDirForServer(wt.codeDir);
      checkDirForServer(wt.worktreePath);
    } catch {}
  }

  if (candidateScripts.length === 0) return false;
  const chosen = candidateScripts[0];
  try {
    const child = spawn(process.execPath, [chosen.scriptPath], {
      cwd: chosen.cwd,
      env: buildAgentExecEnv(chosen.cwd, chosen.cwd, { PORT: String(port) }),
      stdio: "ignore",
      detached: true
    });
    child.unref();
    managedAgentPortProcesses.set(Number(port), child);
  } catch {
    return false;
  }

  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 150));
    if (await isLocalPortListening(port)) return true;
  }
  return false;
}

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.log(`Vanaras Desktop Engine is already running on http://localhost:${PORT}`);
    process.exit(0);
  }
  console.error("Server error:", err);
});

server.listen(PORT, "0.0.0.0", () => {
  const promoted = syncAllWorktreesToMainRoot();
  ensureAgentPortServerRunning(3847, "bot_r1").catch(() => {});
  console.log(`Vanaras Desktop Engine listening at http://localhost:${PORT}${promoted.length > 0 ? ` (synced ${promoted.length} deliverables to main root)` : ""}`);
});

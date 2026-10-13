import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { exec, execSync, spawn } from "node:child_process";
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

// Background tasks registry
const backgroundJobs = new Map();

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
// PER-AGENT ISOLATED GIT WORKTREE MANAGER (.worktrees/<botId>)
// ============================================================================
function ensureAgentWorktree(botId, botName) {
  const botSlug = sanitizeSlug(botId, "bot");
  const nameSlug = sanitizeSlug(botName || botId, "vanara");
  const branchName = `vanara/${nameSlug}`;
  const worktreePath = path.join(WORKTREES_DIR, botSlug);

  try {
    if (!fs.existsSync(path.join(worktreePath, ".git"))) {
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      execSync(`git worktree add -B "${branchName}" "${worktreePath}" HEAD`, {
        cwd: ROOT_DIR,
        stdio: "pipe",
        timeout: 10000
      });
    }
  } catch {
    // Fallback if git worktree is locked or already exists
    fs.mkdirSync(worktreePath, { recursive: true });
  }

  let status = "";
  let diffStat = "";
  let commits = "";
  try {
    status = execSync("git status --short", { cwd: worktreePath, stdio: "pipe", timeout: 4000 }).toString("utf8").trim();
    diffStat = execSync("git diff --stat", { cwd: worktreePath, stdio: "pipe", timeout: 4000 }).toString("utf8").trim();
    commits = execSync("git log --oneline -n 4", { cwd: worktreePath, stdio: "pipe", timeout: 4000 }).toString("utf8").trim();
  } catch {}

  return {
    botId,
    botName,
    branch: branchName,
    worktreePath,
    status: status || "Clean worktree",
    diffStat: diffStat || "No uncommitted diff",
    commits
  };
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

// Gather grounded filesystem & git snapshot from a mounted directory
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

    return {
      exists: true,
      path: resolved,
      entries,
      snippets,
      summary: `Mounted Path: ${resolved}\nTop-level files: ${entries.join(", ")}\n${snippets.join("\n\n")}`
    };
  } catch (e) {
    return { exists: false, path: resolved, summary: `Error inspecting ${resolved}: ${e.message}` };
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
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

  // 2B. Per-Agent Isolated Git Worktree Endpoint (/api/agent/worktree)
  if (req.method === "POST" && req.url === "/api/agent/worktree") {
    try {
      const { botId, botName, action = "ensure", filePath, content, commitMessage } = await readJsonBody(req);
      const wt = ensureAgentWorktree(botId || "bot_r1", botName || "R1");

      if (action === "write_file" && filePath) {
        const cleanRel = filePath.replace(/^\/+/, "").replace(/\.\./g, "");
        const absTarget = path.resolve(wt.worktreePath, cleanRel);
        if (absTarget.startsWith(wt.worktreePath)) {
          fs.mkdirSync(path.dirname(absTarget), { recursive: true });
          fs.writeFileSync(absTarget, content || "", "utf8");
        }
        return sendJson(res, 200, { ...ensureAgentWorktree(botId, botName), writtenFile: cleanRel });
      }

      if (action === "commit") {
        const msg = (commitMessage || `feat(${wt.botName}): autonomous worktree update`).replace(/"/g, "'");
        try {
          execSync(`git add -A && git commit -m "${msg}"`, { cwd: wt.worktreePath, stdio: "pipe" });
        } catch {}
        return sendJson(res, 200, ensureAgentWorktree(botId, botName));
      }

      if (action === "diff") {
        let fullDiff = "";
        try {
          fullDiff = execSync("git diff HEAD", { cwd: wt.worktreePath, stdio: "pipe", timeout: 4000 }).toString("utf8").trim();
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
      const { botId, action = "get", fact, index, memories } = await readJsonBody(req);
      let current = loadAgentMemory(botId);
      if (action === "add" && fact) {
        if (!current.includes(fact)) current.unshift(fact);
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
      const { botId, botName, tool, args = {}, mcpCommand } = await readJsonBody(req);
      const wt = ensureAgentWorktree(botId || "bot_r1", botName || "R1");

      if (tool === "mcp_probe" && mcpCommand) {
        const mcpRes = await callStdioMcpServer({ commandLine: mcpCommand, cwd: wt.worktreePath, method: "tools/list" });
        return sendJson(res, 200, mcpRes);
      }

      if (tool === "mcp_call" && mcpCommand) {
        const mcpRes = await callStdioMcpServer({
          commandLine: mcpCommand,
          cwd: wt.worktreePath,
          method: "tools/call",
          params: { name: args.name, arguments: args.arguments || {} }
        });
        return sendJson(res, 200, mcpRes);
      }

      if (tool === "fs_read") {
        const rel = String(args.path || "README.md").replace(/^\/+/, "").replace(/\.\./g, "");
        const target = path.resolve(wt.worktreePath, rel);
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          return sendJson(res, 200, { ok: false, output: `File not found in ${wt.branch}: ${rel}` });
        }
        const text = fs.readFileSync(target, "utf8").slice(0, 3000);
        return sendJson(res, 200, { ok: true, worktreePath: wt.worktreePath, branch: wt.branch, output: text });
      }

      if (tool === "fs_write") {
        const rel = String(args.path || "notes.md").replace(/^\/+/, "").replace(/\.\./g, "");
        const target = path.resolve(wt.worktreePath, rel);
        if (target.startsWith(wt.worktreePath)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, String(args.content || ""), "utf8");
          return sendJson(res, 200, {
            ok: true,
            worktreePath: wt.worktreePath,
            branch: wt.branch,
            output: `Wrote ${ (args.content || "").length } bytes to ${rel} in worktree (${wt.branch})`
          });
        }
      }

      if (tool === "git_status" || tool === "git_diff") {
        const cmd = tool === "git_diff" ? "git diff HEAD" : "git status --short && git branch --show-current";
        const out = execSync(cmd, { cwd: wt.worktreePath, stdio: "pipe", timeout: 5000 }).toString("utf8").trim();
        return sendJson(res, 200, { ok: true, worktreePath: wt.worktreePath, branch: wt.branch, output: out || "(Clean worktree)" });
      }

      return sendJson(res, 400, { error: `Unknown agent tool: ${tool}` });
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

  // 4. Asynchronous Background Command / Tool Runner (POST /api/workspace/exec)
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
      backgroundJobs.set(jobId, { id: jobId, command, status: "running", startedAt: Date.now() });

      broadcastEvent("job_started", { jobId, command, threadId, botId, botName, cwd: targetCwd, branch });

      const execOptions = {
        cwd: targetCwd,
        timeout: 25000,
        maxBuffer: 1024 * 512,
        ...(process.platform === "win32" ? { shell: "powershell.exe" } : {})
      };

      exec(command, execOptions, (error, stdout, stderr) => {
        const output = ((stdout || "") + (stderr ? `\n${stderr}` : "")).trim().slice(0, 4000);
        const exitCode = error ? (error.code || 1) : 0;
        backgroundJobs.set(jobId, { id: jobId, command, status: "done", exitCode, output });
        broadcastEvent("job_finished", {
          jobId,
          command,
          cwd: targetCwd,
          branch,
          exitCode,
          output: output || "(Command completed with no output)",
          threadId,
          botId,
          botName
        });
      });

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

  // 6. Universal Multi-Provider LLM Chat Proxy (Local, OpenRouter, Gemini, OpenAI, Claude, Qwen, Grok)
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

      const cleanBase = baseUrl.replace(/\/+$/, "");

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

      // OpenAI-Compatible (Local LM Studio, Ollama, OpenRouter, OpenAI, Qwen, xAI Grok)
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

      const upstream = await fetch(chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

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
      const cleanBase = baseUrl.replace(/\/+$/, "");

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

      const upstream = await fetch(modelsUrl, { method: "GET", headers });
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
        if (!safePath.startsWith(baseTarget)) continue;
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
  const reqPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const targetFile = path.join(__dirname, reqPath);

  if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
    const ext = path.extname(targetFile);
    let contentType = "text/html; charset=utf-8";
    if (ext === ".js" || ext === ".mjs") contentType = "application/javascript";
    else if (ext === ".css") contentType = "text/css";
    else if (ext === ".json") contentType = "application/json";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache, no-store, must-revalidate"
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

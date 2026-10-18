#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VANARAS_ROOT = __dirname;

function normalizeBotId(raw) {
  if (!raw) return "bot_r1";
  const str = String(raw).trim();
  if (str.startsWith("bot_")) return str.toLowerCase();
  return `bot_${str.toLowerCase()}`;
}

function parseCliArgs(argv) {
  const options = {
    command: null,
    positionals: [],
    agent: "bot_r1",
    url: process.env.VANARAS_URL || process.env.BASE_URL || "http://127.0.0.1:3000",
    help: false
  };

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--agent" && i + 1 < args.length) {
      options.agent = normalizeBotId(args[++i]);
    } else if (arg.startsWith("--agent=")) {
      options.agent = normalizeBotId(arg.split("=")[1]);
    } else if (arg === "--url" && i + 1 < args.length) {
      options.url = args[++i];
    } else if (arg.startsWith("--url=")) {
      options.url = arg.split("=")[1];
    } else if ((arg === "--verify" || arg === "-v") && i + 1 < args.length) {
      options.verify = args[++i];
    } else if (arg.startsWith("--verify=")) {
      options.verify = arg.split("=")[1];
    } else if (!arg.startsWith("-")) {
      if (!options.command) {
        options.command = arg;
      } else {
        options.positionals.push(arg);
      }
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Vanaras CLI Companion
=====================
Usage:
  vanaras-cli <command> [options]

Commands:
  status                    Check server health, active worktrees, branches, and file counts
  ask "<prompt>"            Send prompt or instruction to an agent
  diff [--agent <id>]       Display git unified diff for the agent's worktree
  search "<query>"          Fast regex/string search across codebase and worktrees

Options:
  --agent <id>              Agent identifier (e.g. R1, bot_r1, R2). Default: R1
  --url <url>               Vanaras server URL. Default: http://127.0.0.1:3000
  --help, -h                Show this help message
`);
}

async function requestJson(url, options = {}, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        // The project the CLI works on: VANARAS_PROJECT, else the folder it is run from.
        "X-Vanaras-Project": encodeURIComponent(process.env.VANARAS_PROJECT || process.cwd()),
        ...(options.headers || {})
      }
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function handleStatus(opts) {
  let serverHealthy = false;
  let serverInfo = null;
  let workspaceInfo = null;

  try {
    const healthRes = await requestJson(`${opts.url}/api/health`, { method: "GET" });
    if (healthRes.ok && healthRes.body?.ok) {
      serverHealthy = true;
      serverInfo = healthRes.body;
    }
  } catch {}

  if (serverHealthy) {
    try {
      const wsRes = await requestJson(`${opts.url}/api/workspace`, { method: "GET" });
      if (wsRes.ok) {
        workspaceInfo = wsRes.body;
      }
    } catch {}
  }

  const worktreesDir = path.join(VANARAS_ROOT, ".worktrees");
  const localWorktrees = [];
  if (fs.existsSync(worktreesDir)) {
    try {
      const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const wtPath = path.join(worktreesDir, entry.name);
          let fileCount = 0;
          try {
            const files = fs.readdirSync(wtPath);
            fileCount = files.length;
          } catch {}
          localWorktrees.push({ name: entry.name, path: wtPath, fileCount });
        }
      }
    } catch {}
  }

  let currentBranch = "main";
  try {
    currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: VANARAS_ROOT,
      stdio: "pipe"
    }).toString("utf8").trim();
  } catch {}

  console.log("===================================================================");
  console.log("                   VANARAS SYSTEM STATUS                          ");
  console.log("===================================================================");
  console.log(`Server Endpoint: ${opts.url}`);
  console.log(`Server Health:   ${serverHealthy ? "ONLINE (PID: " + serverInfo.pid + ", Port: " + serverInfo.port + ")" : "OFFLINE / LOCAL"}`);
  console.log(`Repository Root: ${VANARAS_ROOT}`);
  console.log(`Current Branch:  ${currentBranch}`);
  console.log("Active Worktrees:");
  if (localWorktrees.length === 0) {
    console.log("  (None found)");
  } else {
    for (const wt of localWorktrees) {
      console.log(`  - ${wt.name}: ${wt.fileCount} top-level files (${wt.path})`);
    }
  }
  if (workspaceInfo && workspaceInfo.state) {
    const botCount = Array.isArray(workspaceInfo.state.bots) ? workspaceInfo.state.bots.length : 0;
    console.log(`Registered Agents: ${botCount}`);
  }
  console.log("===================================================================");
}

async function handleDiff(opts) {
  const botId = opts.agent;
  let diffText = "";

  try {
    const res = await requestJson(`${opts.url}/api/agent/workspace`, {
      method: "POST",
      body: JSON.stringify({
        action: "diff",
        botId
      })
    });
    if (res.ok && res.body?.diff) {
      diffText = res.body.diff;
    }
  } catch {}

  // Fallback to local git diff if server is offline or returned empty
  if (!diffText) {
    const wtDir = path.join(VANARAS_ROOT, ".worktrees", botId);
    const targetDir = fs.existsSync(wtDir) ? wtDir : VANARAS_ROOT;
    try {
      const gitDiff = execFileSync("git", ["diff", "HEAD"], {
        cwd: targetDir,
        stdio: "pipe"
      }).toString("utf8");
      if (gitDiff) diffText += gitDiff;

      const statusOut = execFileSync("git", ["status", "--porcelain"], {
        cwd: targetDir,
        stdio: "pipe"
      }).toString("utf8");

      for (const line of statusOut.split(/\r?\n/).filter(Boolean)) {
        const code = line.slice(0, 2).trim();
        const rel = line.slice(3).trim();
        if (code === "??" || code === "?") {
          const fullPath = path.resolve(targetDir, rel);
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            const content = fs.readFileSync(fullPath, "utf8");
            const lines = content.split(/\r?\n/);
            diffText += `diff --git a/${rel} b/${rel}\n`;
            diffText += `new file mode 100644\n`;
            diffText += `--- /dev/null\n`;
            diffText += `+++ b/${rel}\n`;
            diffText += `@@ -0,0 +1,${lines.length} @@\n`;
            for (const l of lines) {
              diffText += `+${l}\n`;
            }
          }
        }
      }
    } catch {}
  }

  if (diffText.trim()) {
    console.log(diffText);
  } else {
    console.log(`No active modifications or diff for agent ${botId}.`);
  }
}

async function handleSearch(opts) {
  const query = opts.positionals[0];
  if (!query) {
    console.error("Error: search query required. Usage: vanaras-cli search <query>");
    process.exit(1);
  }

  let matches = [];
  try {
    const res = await requestJson(`${opts.url}/api/agent/tool`, {
      method: "POST",
      body: JSON.stringify({
        action: "grep_search",
        botId: opts.agent,
        content: query
      })
    });
    if (res.ok && Array.isArray(res.body?.matches)) {
      matches = res.body.matches;
    }
  } catch {}

  // Fallback to local git grep if server is offline or returned empty
  if (matches.length === 0) {
    try {
      const grepOut = execFileSync("git", ["grep", "-n", "-I", query], {
        cwd: VANARAS_ROOT,
        stdio: "pipe"
      }).toString("utf8");

      for (const line of grepOut.split(/\r?\n/).filter(Boolean)) {
        const parts = line.split(":");
        if (parts.length >= 3) {
          const file = parts[0];
          const lineNum = parseInt(parts[1], 10);
          const text = parts.slice(2).join(":");
          matches.push({ file, line: lineNum, text });
        }
      }
    } catch {}
  }

  if (matches.length === 0) {
    console.log(`No matches found for query: "${query}"`);
    return;
  }

  for (const m of matches) {
    console.log(`${m.file}:${m.line}: ${m.text}`);
  }
}

async function handleAsk(opts) {
  const prompt = opts.positionals.join(" ") || opts.positionals[0];
  if (!prompt) {
    console.error("Error: prompt text required. Usage: vanaras-cli ask \"<prompt>\" [--agent <id>] [--verify <cmd>]");
    process.exit(1);
  }

  const threadId = `cli_${Date.now()}`;
  console.log(`[Vanaras CLI]: Initiating server-side autonomous turn for agent ${opts.agent}...`);
  console.log(`Prompt: "${prompt}"`);
  if (opts.verify) {
    console.log(`Verify Command: "${opts.verify}"`);
  }

  let turnStarted = false;
  try {
    const res = await requestJson(`${opts.url}/api/sessions/turn`, {
      method: "POST",
      body: JSON.stringify({
        threadId,
        botId: opts.agent,
        prompt,
        verifyCommand: opts.verify || ""
      })
    }, 10000);
    if (res.ok && res.body?.ok) {
      turnStarted = true;
    } else {
      console.warn(`Server-side turn dispatch failed (${res.status}): ${res.body?.error || "Unknown error"}. Falling back to event bus.`);
    }
  } catch (e) {
    console.warn(`Could not reach /api/sessions/turn: ${e.message}`);
  }

  if (!turnStarted) {
    const payload = { sender: "Human (CLI)", text: prompt, botId: opts.agent, timestamp: new Date().toISOString() };
    let published = false;
    try {
      const res = await requestJson(`${opts.url}/api/events/publish`, { method: "POST", body: JSON.stringify(payload) });
      if (res.ok) published = true;
    } catch {}
    if (published) console.log("Status: Accepted by Vanaras event bus.");
    else console.log("Status: Queued locally (Server unreachable at " + opts.url + ").");
    return;
  }

  console.log(`Turn started (threadId: ${threadId}). Streaming execution...\n`);

  let lastStatus = "";
  let lastMessage = "";
  const pollIntervalMs = 750;
  const maxWaitMs = 600000;
  const startTime = Date.now();

  const cleanupAndExit = async (code = 0) => {
    try {
      await requestJson(`${opts.url}/api/sessions/stop`, {
        method: "POST",
        body: JSON.stringify({ threadId, botId: opts.agent })
      });
    } catch {}
    process.exit(code);
  };

  process.on("SIGINT", () => {
    console.log("\n[CLI]: Interrupted by user. Stopping turn on server...");
    cleanupAndExit(130);
  });

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    try {
      const st = await requestJson(`${opts.url}/api/sessions/status?threadId=${encodeURIComponent(threadId)}`, { method: "GET" }, 3000);
      if (st.ok && st.body?.turn) {
        const turn = st.body.turn;
        if (turn.status === "completed" || turn.status === "stopped" || turn.status === "error") {
          console.log(`\n================== TURN COMPLETED (${turn.status.toUpperCase()}) ==================`);
          if (turn.reasoning) {
            console.log(`\n--- Agent Thoughts ---\n${turn.reasoning}\n`);
          }
          if (turn.finalContent) {
            console.log(`\n--- Agent Deliverables / Output ---\n${turn.finalContent}\n`);
          }
          if (turn.error) {
            console.error(`\nError: ${turn.error}`);
            process.exit(1);
          }
          process.exit(0);
        }

        const msg = turn.message || turn.status;
        if (msg && msg !== lastMessage) {
          lastMessage = msg;
          console.log(`[Step ${turn.step}/${turn.maxSteps}] ${msg}`);
        }
      }
    } catch {}
  }

  console.warn("\n[CLI]: Turn monitoring timed out after 10 minutes. The agent may still be running in the background.");
}

async function main() {
  const opts = parseCliArgs(process.argv);

  if (opts.help || !opts.command) {
    printHelp();
    process.exit(0);
  }

  switch (opts.command) {
    case "status":
      await handleStatus(opts);
      break;
    case "diff":
      await handleDiff(opts);
      break;
    case "search":
      await handleSearch(opts);
      break;
    case "ask":
      await handleAsk(opts);
      break;
    default:
      console.error(`Unknown command: ${opts.command}`);
      printHelp();
      process.exit(0);
  }
}

main().catch(err => {
  console.error("CLI error:", err);
  process.exit(1);
});

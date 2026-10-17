// Local preview-port detection and auto-boot of agent preview servers.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PORT } from "./config.mjs";
import { buildAgentExecEnv } from "./env.mjs";
import { managedAgentPortProcesses } from "./state.mjs";
import { ensureAgentWorktree } from "./worktree.mjs";

export async function isLocalPortListening(port) {
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

export async function ensureAgentPortServerRunning(port, preferredBotId = "bot_r1") {
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

// Local preview-port detection and auto-boot of agent preview servers.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PORT, WORKTREES_DIR } from "./config.mjs";
import { buildAgentExecEnv } from "./env.mjs";
import { managedAgentPortProcesses } from "./state.mjs";
import { projectKey } from "./projects.mjs";
import { agentWorktreePath } from "./worktree.mjs";

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

// Starts the dev server a room's agents wrote for `port`, if one exists and nothing is listening yet. Only the
// room's project and its agents' worktrees are searched, and only a script that mentions the port (or reads
// PORT from the environment) is started.
export async function ensureAgentPortServerRunning(port, preferredBotId = "", projectRoot = "") {
  if (!port || Number(port) === Number(PORT)) return false;
  if (await isLocalPortListening(port)) return true;
  if (!projectRoot) return false;

  const candidateScripts = [];
  const checkDirForServer = (dir) => {
    if (!dir || !fs.existsSync(dir)) return;
    for (const rel of ["server.mjs", "server.js", "ui/server.mjs", "ui/server.js", "app.mjs", "app.js"]) {
      const p = path.join(dir, rel);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        try {
          const src = fs.readFileSync(p, "utf8");
          if (src.includes(String(port)) || /process\.env\.PORT/.test(src)) {
            candidateScripts.push({ scriptPath: p, cwd: path.dirname(p) });
          }
        } catch {}
      }
    }
  };

  const worktreesOfProject = path.join(WORKTREES_DIR, projectKey(projectRoot));
  if (preferredBotId) checkDirForServer(agentWorktreePath(projectRoot, preferredBotId));
  checkDirForServer(projectRoot);
  try {
    for (const ent of fs.readdirSync(worktreesOfProject, { withFileTypes: true })) {
      if (ent.isDirectory()) checkDirForServer(path.join(worktreesOfProject, ent.name));
    }
  } catch {}

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

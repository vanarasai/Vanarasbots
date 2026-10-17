// Agent execution environment: shared venv discovery/symlinks and the PATH/PYTHONPATH/NODE_PATH builder.
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR, WORKTREES_DIR } from "./config.mjs";
import { RUNTIME_NODE_MODULES, ensureBuiltinExpressShim } from "./express-shim.mjs";

export function hasVenvPython(venvDir) {
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

export function resolveSharedVenvDir(cwd = "", worktreePath = "") {
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

export function ensureSharedVenvSymlinks(worktreePath = "", codeDir = "") {
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

export function buildAgentExecEnv(cwd = "", worktreePath = "") {
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

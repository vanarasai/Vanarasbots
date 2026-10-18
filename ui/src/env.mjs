// Agent execution environment: the Python venv of the agent's own checkout or its project, and the
// PATH/PYTHONPATH/NODE_PATH for commands run in the worktree. Nothing outside the project is put on a path.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

const projectRootCache = new Map();

// The main checkout a worktree belongs to (its shared .git directory's parent). Untracked things such as a
// .venv live there, not in the agent's worktree.
export function projectRootOf(worktreePath) {
  if (!worktreePath) return "";
  if (projectRootCache.has(worktreePath)) return projectRootCache.get(worktreePath);
  let root = "";
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktreePath, stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).toString().trim();
    root = path.dirname(common);
  } catch {}
  projectRootCache.set(worktreePath, root);
  return root;
}

// A venv for this agent: one in the folder it runs in or its checkout, else the project's own .venv.
export function resolveSharedVenvDir(cwd = "", worktreePath = "") {
  const projectRoot = projectRootOf(worktreePath || cwd);
  const candidates = [cwd, worktreePath, projectRoot].filter(Boolean).map(d => path.join(d, ".venv"));
  for (const cand of candidates) {
    if (hasVenvPython(cand)) {
      try { return fs.realpathSync(cand); } catch { return cand; }
    }
  }
  return "";
}

export function buildAgentExecEnv(cwd = "", worktreePath = "", extraEnv = {}) {
  ensureBuiltinExpressShim();
  const venv = resolveSharedVenvDir(cwd, worktreePath);
  const venvBin = venv ? (process.platform === "win32" ? path.join(venv, "Scripts") : path.join(venv, "bin")) : "";
  const currentPath = process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  const pathEntries = [venvBin, "/opt/homebrew/bin", "/usr/local/bin", ...currentPath.split(path.delimiter)].filter(Boolean);
  const projectRoot = projectRootOf(worktreePath || cwd);
  const pyPaths = [cwd, worktreePath, process.env.PYTHONPATH || ""].filter(Boolean);
  const nodePaths = [
    worktreePath ? path.join(worktreePath, "node_modules") : "",
    projectRoot ? path.join(projectRoot, "node_modules") : "",
    RUNTIME_NODE_MODULES,
    process.env.NODE_PATH || ""
  ].filter(Boolean);
  return {
    ...process.env,
    PATH: [...new Set(pathEntries)].join(path.delimiter),
    ...(venv ? { VIRTUAL_ENV: venv } : {}),
    PYTHONUNBUFFERED: "1",
    PYTHONPATH: [...new Set(pyPaths)].join(path.delimiter),
    NODE_PATH: [...new Set(nodePaths)].join(path.delimiter),
    ...extraEnv
  };
}

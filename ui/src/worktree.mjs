// Per-agent git worktrees of the room's project: each agent works on its own branch (vanara/<name>) of the
// project repository, checked out under WORKTREES_DIR/<project-key>/<agent>. Work reaches the project only
// by merging that branch; nothing is copied between worktrees or into Vanaras.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WORKTREES_DIR } from "./config.mjs";
import { projectKey, requireProject } from "./projects.mjs";
import { sanitizeSlug } from "./util.mjs";

function git(cwd, args, timeout = 10000) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout }).toString().trim();
}

export function agentBranchName(botId, botName) {
  const botSlug = sanitizeSlug(botId, "bot");
  const effectiveName = (botName && (botName !== "R1" || botId === "bot_r1")) ? botName : (botId ? botId.replace(/^bot_/, "") : "r1");
  const nameSlug = sanitizeSlug(effectiveName, "vanara");
  return String(botId || "").startsWith("sub_") ? `vanara/${nameSlug}-${botSlug}` : `vanara/${nameSlug}`;
}

// Real path, so it compares equal to what `git worktree list` reports (macOS: /var -> /private/var).
function worktreesRoot() {
  try { return fs.realpathSync(WORKTREES_DIR); } catch { return WORKTREES_DIR; }
}

export function agentWorktreePath(projectRoot, botId) {
  return path.join(worktreesRoot(), projectKey(projectRoot), sanitizeSlug(botId, "bot"));
}

function existingCheckout(projectRoot, branch) {
  try {
    let current = "";
    for (const line of git(projectRoot, ["worktree", "list", "--porcelain"]).split("\n")) {
      if (line.startsWith("worktree ")) current = line.slice(9);
      else if (line === `branch refs/heads/${branch}` && current && current !== projectRoot && fs.existsSync(path.join(current, ".git"))) return current;
    }
  } catch {}
  return "";
}

// Creates (or reuses) the agent's worktree of `projectPath`. The project must be a git repository with a
// commit; otherwise this throws ProjectError and the caller asks the user to choose or initialise one.
export function ensureAgentWorktree(botId, botName, projectPath) {
  const projectRoot = requireProject(projectPath);
  const branch = agentBranchName(botId, botName);
  // If this project already has the agent's branch checked out somewhere (e.g. a worktree made before
  // worktrees were grouped per project), keep using it: git allows one checkout per branch.
  const worktreePath = existingCheckout(projectRoot, branch) || agentWorktreePath(projectRoot, botId);

  if (!fs.existsSync(path.join(worktreePath, ".git"))) {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    try {
      // Reuse the agent's branch if it already exists in this project; otherwise start it at HEAD.
      let branchExists = true;
      try { git(projectRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]); } catch { branchExists = false; }
      git(projectRoot, ["worktree", "prune"]);
      git(projectRoot, branchExists ? ["worktree", "add", worktreePath, branch] : ["worktree", "add", "-b", branch, worktreePath, "HEAD"], 30000);
    } catch (err) {
      if (fs.existsSync(worktreePath) && !fs.existsSync(path.join(worktreePath, ".git"))) {
        try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
      }
      throw err;
    }
  }

  let status = "";
  let diffStat = "";
  let commits = "";
  try {
    status = git(worktreePath, ["status", "--short"], 4000);
    diffStat = git(worktreePath, ["diff", "--stat"], 4000);
    commits = git(worktreePath, ["log", "--oneline", "-n", "4"], 4000);
  } catch {}

  return {
    ok: true,
    botId,
    botName,
    projectRoot,
    branch,
    worktreePath,
    worktreeDir: worktreePath,
    // The agent works directly in its checkout of the project.
    codeDir: worktreePath,
    status: status || "Clean worktree",
    diffStat: diffStat || "No uncommitted diff",
    diff: diffStat || "No uncommitted diff",
    commits
  };
}

const LIST_SKIP_DIRS = new Set(["node_modules", "target", "__pycache__", ".venv", "venv", "dist", "build", ".next"]);

// Source files in the agent's checkout, for the workspace panel (small text files only).
export function listAgentCodeFiles(codeDir, { limit = 40, maxBytes = 256 * 1024 } = {}) {
  const results = [];
  function walk(dir, relPrefix = "") {
    if (results.length >= limit || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= limit) return;
      if (entry.name.startsWith(".") || LIST_SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size <= maxBytes && !/\.(wav|mp3|ogg|m4a|mp4|webm|mov|png|jpg|jpeg|gif|webp|pyc|pyo|zip|gz|pdf)$/i.test(entry.name)) {
            results.push({ name: relPath, size: stat.size, updatedAt: stat.mtimeMs, content: fs.readFileSync(fullPath, "utf8") });
          }
        } catch {}
      }
    }
  }
  walk(codeDir);
  return results;
}

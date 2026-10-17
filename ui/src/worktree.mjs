// Per-agent isolated git worktrees and deliverable synchronisation to the main checkout.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { ROOT_DIR, WORKSPACE_FILE, WORKTREES_DIR } from "./config.mjs";
import { ensureSharedVenvSymlinks } from "./env.mjs";
import { isPathInside, sanitizeSlug } from "./util.mjs";

// ============================================================================
// PER-AGENT ISOLATED GIT WORKTREE & CODE WORKSPACE MANAGER (.worktrees/<botId>)
// ============================================================================
export const LEGACY_TEMPLATE_FILES = new Set([
  "gguf_dump.py", "quant_architecture.md", "embedding_lookup.py",
  "lookup_table.rs", "calibrate_q3.py", "phone_rss_probe.py", "vanara_task.py",
  "solution.py", "calc.js"
]);

export function ensureAgentWorktree(botId, botName, customWorkspacePath = "") {
  const botSlug = sanitizeSlug(botId, "bot");
  const effectiveName = (botName && (botName !== "R1" || botId === "bot_r1")) ? botName : (botId ? botId.replace(/^bot_/, "") : "r1");
  const nameSlug = sanitizeSlug(effectiveName, "vanara");
  const branchName = (botId && botId.startsWith("sub_")) ? `vanara/${nameSlug}-${botSlug}` : `vanara/${nameSlug}`;
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

export function listAgentCodeFiles(codeDir) {
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

export const RESERVED_ROOT_ENTRIES = new Set([
  "ui", "crates", "macos", "Vanaras.app", "agent_workspace", "projects",
  "target", "node_modules", "skills", "docs", ".git", ".gitignore",
  ".worktrees", ".vanaras-memory", ".DS_Store", "__pycache__", ".pytest_cache",
  "Cargo.toml", "Cargo.lock", "package.json", "package-lock.json",
  "README.md", "AGENTS.md", "CONTRIBUTING.md", "build-macos-app.sh", "run-windows.bat"
]);

export const STARTER_BOILERPLATE_FILES = new Set([
  "gguf_dump.py", "quant_architecture.md", "embedding_lookup.py", "lookup_table.rs",
  "calibrate_q3.py", "phone_rss_probe.py", "main.py", "vanara_task.py", "notes.md", "health_check.py", "calc.js", "solution.py", "Vanaras.command"
]);

export function isDeliverableRelPathAllowed(relPath, { allowAgentSubdirs = false } = {}) {
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

export function collectDeliverablesInDir(baseDir, { allowAgentSubdirs = false } = {}) {
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

export function copyIfNewer(srcAbs, srcMtimeMs, destAbs) {
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
    // A replica must carry the mtime of the content's origin. copyFileSync stamps "now", which would make
    // a stale replica look newer than a later real edit elsewhere and get promoted over it on the next pass.
    const srcStat = fs.statSync(srcAbs);
    fs.utimesSync(destAbs, srcStat.atime, srcStat.mtime);
    return true;
  } catch {
    return false;
  }
}

export function recoverTruncatedWorkspaceFilesFromHistory(agentCodeDirs = []) {
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

export function syncWorktreeDeliverablesToMainRoot(wt, { syncSiblings = true } = {}) {
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

export function syncAllWorktreesToMainRoot() {
  return syncWorktreeDeliverablesToMainRoot(null, { syncSiblings: true });
}

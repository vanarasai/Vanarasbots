// Small, dependency-free helpers (slugging, path containment, git commit helpers).
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";

export function getAgentAssignedPort(botId = "bot_r1") {
  const known = { bot_r1: 4101, bot_r2: 4102, bot_r3: 4103, bot_r4: 4104, bot_waffle: 4105, bot_new: 4106 };
  if (known[botId]) return known[botId];
  let hash = 0;
  for (let i = 0; i < botId.length; i++) hash = (hash * 31 + botId.charCodeAt(i)) % 800;
  return 4110 + hash;
}

export function sanitizeSlug(str, fallback = "agent") {
  return String(str || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || fallback;
}

export function isPathInside(childPath, parentDir) {
  const resolvedChild = path.resolve(childPath);
  const resolvedParent = path.resolve(parentDir);
  const rel = path.relative(resolvedParent, resolvedChild);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function execFileAsync(bin, args = [], options = {}) {
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

export function safeGitCommit(cwd, message, timeout = 5000) {
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

export async function safeGitCommitAsync(cwd, message, timeout = 5000) {
  try {
    await execFileAsync("git", ["add", "-A"], { cwd, timeout });
    const { stdout } = await execFileAsync("git", ["commit", "-m", String(message || "checkpoint")], { cwd, timeout });
    return stdout.trim();
  } catch (e) {
    return String(e.stdout || "").trim();
  }
}

export function getHeadSha(cwd) {
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

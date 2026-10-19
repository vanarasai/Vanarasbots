// Paths, port, and runtime-state locations. Environment overrides (VANARAS_PORT, VANARAS_STATE_DIR,
// VANARAS_WORKTREES_DIR) are additive; defaults are unchanged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT_DIR = path.resolve(UI_DIR, "..");
export const REPO_ROOT = path.resolve(ROOT_DIR, "..");

// Mutable runtime state (workspace JSON, API-key vault, per-agent state) defaults to the ui/ directory.
export const STATE_DIR = process.env.VANARAS_STATE_DIR ? path.resolve(process.env.VANARAS_STATE_DIR) : UI_DIR;
export const WORKSPACE_FILE = path.join(STATE_DIR, ".vanaras-workspace.json");
export const KEYS_VAULT_FILE = path.join(STATE_DIR, ".vanaras-keys.json");
export const AGENTS_STATE_DIR = path.join(STATE_DIR, ".vanaras-agents");
// Agents' checkouts live outside Vanaras's source, so an agent working in its worktree is never inside it.
export const WORKTREES_DIR = process.env.VANARAS_WORKTREES_DIR ? path.resolve(process.env.VANARAS_WORKTREES_DIR) : path.join(os.homedir(), ".vanaras", "worktrees");
export const PORT = Number(process.env.VANARAS_PORT) || 3000;

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

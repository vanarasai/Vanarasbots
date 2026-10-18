// A project is the git repository a room works on. Agent worktrees are branches of the project, never of
// Vanaras itself (unless the user deliberately mounts the Vanaras folder as a room's project).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT_DIR } from "./config.mjs";
import { loadWorkspaceDiskState } from "./workspace-state.mjs";

export class ProjectError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
    // Routes answer 409 with the code, so the UI can ask the user to choose or initialise a project.
    this.status = 409;
  }
}

function git(cwd, args, timeout = 10000) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout }).toString().trim();
}

// What a folder is, without changing it: exists, is a git repo (its top level), has a first commit.
export function inspectProject(rawPath) {
  const requested = String(rawPath || "").trim();
  if (!requested) return { ok: false, code: "NO_PROJECT", error: "This room has no project folder. Choose one first." };
  if (!path.isAbsolute(requested)) return { ok: false, code: "NOT_ABSOLUTE", error: `Project folder must be an absolute path: ${requested}` };
  const abs = path.resolve(requested);
  let st;
  try { st = fs.statSync(abs); } catch { return { ok: false, code: "NOT_FOUND", error: `Project folder not found: ${abs}`, path: abs }; }
  if (!st.isDirectory()) return { ok: false, code: "NOT_A_FOLDER", error: `Not a folder: ${abs}`, path: abs };
  let root = "";
  try { root = fs.realpathSync(git(abs, ["rev-parse", "--show-toplevel"])); } catch {}
  const real = fs.realpathSync(abs);
  // Agents always work in a directory separate from Vanaras's own source.
  const vanarasRoot = fs.realpathSync(ROOT_DIR);
  if (real === vanarasRoot || real.startsWith(vanarasRoot + path.sep) || (root && root === vanarasRoot)) {
    return { ok: false, code: "VANARAS_SOURCE", error: `${real} is Vanaras's own source. Rooms must use a separate project folder.`, path: real };
  }
  if (!root) return { ok: false, code: "NOT_GIT", error: `${abs} is not a git repository.`, path: abs };
  let hasCommits = true;
  try { git(root, ["rev-parse", "--verify", "HEAD"]); } catch { hasCommits = false; }
  if (!hasCommits) return { ok: false, code: "NO_COMMITS", error: `${root} has no commits yet, so agents cannot branch from it.`, path: root, root };
  return { ok: true, root, path: real, branch: safeBranch(root) };
}

function safeBranch(root) {
  try { return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]); } catch { return ""; }
}

// Only called after the user agreed: make the folder a repository and commit what is in it, so agents have
// a first commit to branch from. An existing repo with no commits gets the same first commit.
export function initProject(rawPath) {
  const info = inspectProject(rawPath);
  if (info.ok) return info;
  if (info.code !== "NOT_GIT" && info.code !== "NO_COMMITS") throw new ProjectError(info.code, info.error);
  const dir = info.root || info.path;
  if (info.code === "NOT_GIT") git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.name=Vanaras", "-c", "user.email=vanaras@localhost", "commit", "-q", "--allow-empty", "-m", "Initial commit (prepared for Vanaras agents)"], 60000);
  return inspectProject(dir);
}

export function requireProject(rawPath) {
  const info = inspectProject(rawPath);
  if (!info.ok) throw new ProjectError(info.code, info.error, info);
  return info.root;
}

export function projectKey(root) {
  const base = path.basename(root).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40) || "project";
  return `${base}-${crypto.createHash("sha1").update(root).digest("hex").slice(0, 8)}`;
}

function threadMountPath(threadId) {
  if (!threadId) return "";
  const state = loadWorkspaceDiskState();
  return (state?.threads || []).find(t => t.id === threadId)?.mountPath || "";
}

// Which project a request is for: an explicit projectPath, else the room (threadId) it belongs to, else the
// X-Vanaras-Project header the UI sends for the room in view. Throws ProjectError if none or invalid.
export function projectFromRequest(req, body = {}) {
  const explicit = body.projectPath || body.project || "";
  const header = req?.headers?.["x-vanaras-project"] ? decodeURIComponent(String(req.headers["x-vanaras-project"])) : "";
  return requireProject(explicit || threadMountPath(body.threadId) || header);
}

// The response for a missing or invalid project, so the UI can ask the user to choose or initialise one.
export function projectErrorResponse(err) {
  return { status: 409, body: { ok: false, code: err.code, error: err.message, project: err.details } };
}

// Where new projects go when the user does not pick a folder.
export const PROJECTS_HOME = process.env.VANARAS_PROJECTS_HOME ? path.resolve(process.env.VANARAS_PROJECTS_HOME) : path.join(os.homedir(), "VanarasProjects");

export function projectSlug(name) {
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

// One step for a new project: a new (or empty) folder outside Vanaras's source, a git repository with a README
// and .gitignore, and a first commit agents can branch from.
export function createProject({ name = "", location = "" } = {}) {
  const slug = projectSlug(name);
  if (!slug) throw new ProjectError("BAD_NAME", "Give the project a name (letters or numbers).");
  const target = path.resolve(location ? String(location) : path.join(PROJECTS_HOME, slug));
  if (!path.isAbsolute(String(location || target))) throw new ProjectError("NOT_ABSOLUTE", `Project folder must be an absolute path: ${location}`);
  const vanarasRoot = fs.realpathSync(ROOT_DIR);
  let probe = target;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  const realProbe = fs.realpathSync(probe);
  if (realProbe === vanarasRoot || realProbe.startsWith(vanarasRoot + path.sep)) {
    throw new ProjectError("VANARAS_SOURCE", `${target} is inside Vanaras's own source. Choose a folder outside it.`);
  }
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) throw new ProjectError("NOT_A_FOLDER", `${target} exists and is not a folder.`);
    const entries = fs.readdirSync(target).filter(e => e !== ".DS_Store");
    if (entries.length > 0) throw new ProjectError("EXISTS", `${target} already exists and is not empty. Choose another name or folder.`);
  }
  fs.mkdirSync(target, { recursive: true });
  const title = String(name).trim();
  fs.writeFileSync(path.join(target, "README.md"), `# ${title}\n\nCreated with Vanaras on ${new Date().toISOString().slice(0, 10)}.\n`);
  fs.writeFileSync(path.join(target, ".gitignore"), ["node_modules/", ".venv", "__pycache__/", "*.pyc", ".DS_Store", ""].join("\n"));
  git(target, ["init", "-q", "-b", "main"]);
  git(target, ["add", "-A"]);
  git(target, ["-c", "user.name=Vanaras", "-c", "user.email=vanaras@localhost", "commit", "-q", "-m", `Start ${title}`]);
  return inspectProject(target);
}

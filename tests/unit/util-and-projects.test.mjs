import "./_env.mjs";
import { SANDBOX } from "./_env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sanitizeSlug, isPathInside, getAgentAssignedPort } from "../../ui/src/util.mjs";
import { execFileSync } from "node:child_process";
import { ROOT_DIR } from "../../ui/src/config.mjs";
import { createProject, inspectProject, initProject, projectSlug, requireProject } from "../../ui/src/projects.mjs";
import { loadAgentMemory, loadAgentProjectMemories, saveAgentMemory } from "../../ui/src/agent-store.mjs";
import { agentWorktreePath, ensureAgentWorktree } from "../../ui/src/worktree.mjs";
import { resolveInWorktree } from "../../ui/src/agent-tools.mjs";

test("sanitizeSlug", () => {
  assert.equal(sanitizeSlug("Hello World!"), "hello-world");
  assert.equal(sanitizeSlug("bot_R1"), "bot_r1");
  assert.equal(sanitizeSlug("--a--"), "a");
  assert.equal(sanitizeSlug("a///b"), "a-b");
  assert.equal(sanitizeSlug("", "fallback"), "fallback");
  assert.equal(sanitizeSlug(null, "fallback"), "fallback");
  assert.equal(sanitizeSlug("!!!", "fallback"), "fallback");
  assert.equal(sanitizeSlug("../../etc/passwd"), "etc-passwd", "path traversal cannot survive slugging");
});

test("isPathInside: containment is by path segment, not string prefix", () => {
  assert.equal(isPathInside("/a/b/c", "/a/b"), true);
  assert.equal(isPathInside("/a/b", "/a/b"), true);
  assert.equal(isPathInside("/a/bc", "/a/b"), false, "sibling with a shared prefix is outside");
  assert.equal(isPathInside("/a/b/../x", "/a/b"), false, "dot-dot is resolved before comparing");
  assert.equal(isPathInside("/other", "/a/b"), false);
});

test("agent ports: well-known agents are fixed, others are stable and in range", () => {
  assert.equal(getAgentAssignedPort("bot_r1"), 4101);
  assert.equal(getAgentAssignedPort("bot_r4"), 4104);
  const p = getAgentAssignedPort("bot_custom_agent");
  assert.equal(getAgentAssignedPort("bot_custom_agent"), p, "deterministic");
  assert.ok(p >= 4110 && p < 4910, `port ${p} out of range`);
});

function freshDir(name) {
  const d = path.join(SANDBOX, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(d, { recursive: true });
  return fs.realpathSync(d);
}
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
function repoWithCommit(name) {
  const d = freshDir(name);
  git(d, "init", "-q");
  fs.writeFileSync(path.join(d, "app.js"), "export const x = 1;\n");
  git(d, "add", "-A");
  git(d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first");
  return d;
}

test("projects: a room's folder is classified before any agent may use it", () => {
  assert.equal(inspectProject("").code, "NO_PROJECT");
  assert.equal(inspectProject("relative/path").code, "NOT_ABSOLUTE");
  assert.equal(inspectProject(path.join(SANDBOX, "nope")).code, "NOT_FOUND");
  const plain = freshDir("plain");
  assert.equal(inspectProject(plain).code, "NOT_GIT");
  const empty = freshDir("empty");
  git(empty, "init", "-q");
  assert.equal(inspectProject(empty).code, "NO_COMMITS");
  const repo = repoWithCommit("repo");
  const info = inspectProject(path.join(repo, "."));
  assert.ok(info.ok && info.root === repo);
  assert.equal(inspectProject(ROOT_DIR).code, "VANARAS_SOURCE", "Vanaras's own source is never a room's project");
  assert.equal(inspectProject(path.join(ROOT_DIR, "ui")).code, "VANARAS_SOURCE", "nor any folder inside it");
  assert.throws(() => requireProject(plain), err => err.code === "NOT_GIT" && err.status === 409);
});

test("projects: initialising (only on request) makes a folder a repo with its files in a first commit", () => {
  const plain = freshDir("toinit");
  fs.writeFileSync(path.join(plain, "notes.md"), "# hi\n");
  const info = initProject(plain);
  assert.ok(info.ok, JSON.stringify(info));
  assert.match(git(plain, "ls-files"), /notes\.md/);
});

test("worktrees: an agent's worktree is a vanara/<name> branch of the room's project, reused on later calls", () => {
  const repo = repoWithCommit("proj");
  const wt = ensureAgentWorktree("bot_r1", "R1", repo);
  assert.equal(wt.projectRoot, repo);
  assert.equal(wt.worktreePath, agentWorktreePath(repo, "bot_r1"));
  assert.equal(wt.codeDir, wt.worktreePath, "the agent works directly in its checkout");
  assert.equal(git(wt.worktreePath, "branch", "--show-current"), "vanara/r1");
  assert.ok(fs.existsSync(path.join(wt.worktreePath, "app.js")), "the checkout has the project's files");
  assert.match(git(repo, "worktree", "list"), new RegExp(wt.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(ensureAgentWorktree("bot_r1", "R1", repo).worktreePath, wt.worktreePath);
  const other = repoWithCommit("proj2");
  assert.notEqual(ensureAgentWorktree("bot_r1", "R1", other).worktreePath, wt.worktreePath, "the same agent gets a separate checkout per project");
  assert.throws(() => ensureAgentWorktree("bot_r1", "R1", ""), err => err.code === "NO_PROJECT");
});

test("worktrees: file paths resolve only inside the agent's checkout, including through symlinks", () => {
  const repo = repoWithCommit("confine");
  const wt = ensureAgentWorktree("bot_r2", "R2", repo);
  assert.equal(resolveInWorktree(wt, "app.js").abs, path.join(wt.worktreePath, "app.js"));
  assert.equal(resolveInWorktree(wt, "new/dir/file.txt").rel, path.join("new", "dir", "file.txt"));
  assert.match(resolveInWorktree(wt, "../../etc/passwd").error, /outside this agent's worktree/);
  assert.match(resolveInWorktree(wt, "/etc/passwd").error, /outside this agent's worktree/);
  assert.match(resolveInWorktree(wt, repo + "/app.js").error, /outside this agent's worktree/, "not even the project's main checkout");
  fs.symlinkSync(SANDBOX, path.join(wt.worktreePath, "escape"));
  assert.match(resolveInWorktree(wt, "escape/anything").error, /through a symlink/);
});

test("worktrees: an agent whose branch is already checked out elsewhere in the project keeps using that checkout", () => {
  const repo = repoWithCommit("legacy");
  const legacy = path.join(freshDir("legacy-wt"), "bot_r4");
  git(repo, "worktree", "add", "-q", "-b", "vanara/r4", legacy, "HEAD");
  assert.equal(ensureAgentWorktree("bot_r4", "R4", repo).worktreePath, legacy);
});

test("worktrees: the default location is outside Vanaras's source", async () => {
  const { execFileSync: run } = await import("node:child_process");
  const out = run(process.execPath, ["--input-type=module", "-e", "const c = await import(process.argv[1]); console.log(c.WORKTREES_DIR + '\\n' + c.ROOT_DIR);", new URL("../../ui/src/config.mjs", import.meta.url).href], { env: { ...process.env, VANARAS_WORKTREES_DIR: "", HOME: SANDBOX } }).toString().trim().split("\n");
  const [worktrees, root] = out;
  assert.ok(!isPathInside(worktrees, root), `${worktrees} must not be inside ${root}`);
});

test("new project: one call makes a new folder a git repo with a README, .gitignore and a first commit", () => {
  assert.equal(projectSlug("  Invoice Tracker! v2 "), "invoice-tracker-v2");
  const target = path.join(freshDir("projects-home"), "invoice-tracker");
  const info = createProject({ name: "Invoice Tracker", location: target });
  assert.ok(info.ok && info.root === fs.realpathSync(target) && info.branch === "main", JSON.stringify(info));
  assert.match(fs.readFileSync(path.join(target, "README.md"), "utf8"), /^# Invoice Tracker/);
  assert.equal(git(target, "log", "--format=%s"), "Start Invoice Tracker");
  assert.equal(git(target, "status", "--porcelain"), "", "everything is committed");
});

test("new project: refuses a folder inside Vanaras's source, a non-empty folder, and a blank name", () => {
  assert.throws(() => createProject({ name: "x", location: path.join(ROOT_DIR, "tmp-project") }), err => err.code === "VANARAS_SOURCE");
  const busy = freshDir("busy");
  fs.writeFileSync(path.join(busy, "keep.txt"), "mine");
  assert.throws(() => createProject({ name: "busy", location: busy }), err => err.code === "EXISTS");
  assert.equal(fs.readFileSync(path.join(busy, "keep.txt"), "utf8"), "mine", "an existing folder is left untouched");
  assert.throws(() => createProject({ name: "  !!  " }), err => err.code === "BAD_NAME");
});

test("agent memory: each project has its own list; the pre-project list is kept separately", () => {
  const bot = `bot_mem_${Date.now()}`;
  saveAgentMemory(bot, ["legacy fact"]);
  saveAgentMemory(bot, ["uses Postgres"], "/projects/a");
  saveAgentMemory(bot, ["uses SQLite"], "/projects/b");
  assert.deepEqual(loadAgentMemory(bot, "/projects/a"), ["uses Postgres"]);
  assert.deepEqual(loadAgentMemory(bot, "/projects/b"), ["uses SQLite"]);
  assert.deepEqual(loadAgentMemory(bot, "/projects/new"), [], "a new project starts empty");
  assert.deepEqual(loadAgentMemory(bot), ["legacy fact"]);
  assert.deepEqual(Object.keys(loadAgentProjectMemories(bot)).sort(), ["/projects/a", "/projects/b"]);
});

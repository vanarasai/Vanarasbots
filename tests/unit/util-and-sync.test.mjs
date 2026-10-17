import "./_env.mjs";
import { SANDBOX } from "./_env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sanitizeSlug, isPathInside, getAgentAssignedPort } from "../../ui/src/util.mjs";
import { copyIfNewer, isDeliverableRelPathAllowed, getRootDirTrackedFiles } from "../../ui/src/worktree.mjs";

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

test("deliverable path rules", () => {
  const ok = (p, o) => isDeliverableRelPathAllowed(p, o);
  assert.equal(ok("app.py"), true);
  assert.equal(ok("src/models.py"), true);
  assert.equal(ok("output/episode.wav"), true);
  assert.equal(ok(".env"), false, "dotfiles are never deliverables");
  assert.equal(ok("a/.hidden/x"), false);
  assert.equal(ok("../escape.txt"), false);
  assert.equal(ok("a/__pycache__/x.pyc"), false);
  assert.equal(ok("x.pyc"), false);
  assert.equal(ok("debug.log"), false);
  assert.equal(ok("scratch.tmp"), false);
  assert.equal(ok("output_test/x.wav"), false);
  assert.equal(ok("node_modules/x/index.js"), false);
  assert.equal(ok("README.md"), false, "reserved repo files are not promoted");
  assert.equal(ok("ui/server.mjs"), false, "reserved at the root");
  assert.equal(ok("ui/server.mjs", { allowAgentSubdirs: true }), true, "ui/ is allowed inside an agent's own workspace");
  assert.equal(ok("crates/x.rs", { allowAgentSubdirs: true }), false);
});

// ---------------------------------------------------------------------------------------------------
// copyIfNewer: the replica-sync primitive. These pin the behaviour behind a real data-loss bug where a
// refreshed stale replica was stamped "now", looked newer than the user's edit, and overwrote it.
// ---------------------------------------------------------------------------------------------------
const mtimeOf = (p) => fs.statSync(p).mtimeMs;
function file(name, content, ageSeconds) {
  const p = path.join(SANDBOX, "sync", name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  const t = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(p, t, t);
  return p;
}

test("copyIfNewer: copies newer content over an older destination and creates missing directories", () => {
  const src = file("c1/src.txt", "new", 10);
  const dest = path.join(SANDBOX, "sync", "c1", "deep", "dir", "dest.txt");
  assert.equal(copyIfNewer(src, mtimeOf(src), dest), true);
  assert.equal(fs.readFileSync(dest, "utf8"), "new");
});

test("copyIfNewer: never overwrites a newer destination", () => {
  const src = file("c2/src.txt", "old replica", 100);
  const dest = file("c2/dest.txt", "user edit", 1);
  assert.equal(copyIfNewer(src, mtimeOf(src), dest), false);
  assert.equal(fs.readFileSync(dest, "utf8"), "user edit");
});

test("copyIfNewer: a copy inherits its source's mtime instead of being stamped 'now'", () => {
  const src = file("c3/src.txt", "content", 3600);
  const dest = path.join(SANDBOX, "sync", "c3", "replica.txt");
  assert.equal(copyIfNewer(src, mtimeOf(src), dest), true);
  assert.ok(Math.abs(mtimeOf(dest) - mtimeOf(src)) < 5, `replica mtime ${mtimeOf(dest)} must equal source ${mtimeOf(src)}`);
});

test("copyIfNewer: refreshing a stale replica can never let it overwrite a later real edit (regression)", () => {
  // 1. Two replicas of an agent file exist; one is slightly older than the other.
  const replicaA = file("c4/a/f.txt", "agent v1", 600);
  const replicaB = file("c4/b/f.txt", "agent v1", 601);
  // 2. The user then edits the main copy.
  const main = file("c4/main/f.txt", "agent v1\nUSER EDIT", 30);
  // 3. A sync pass refreshes replica B from replica A (this used to stamp B with "now").
  copyIfNewer(replicaA, mtimeOf(replicaA), replicaB);
  // 4. Next pass: B must NOT now look newer than the user's edit, so it must not be promoted over main.
  assert.ok(mtimeOf(replicaB) < mtimeOf(main), "a refreshed replica must stay older than the later edit");
  assert.equal(copyIfNewer(replicaB, mtimeOf(replicaB), main), false);
  assert.equal(fs.readFileSync(main, "utf8"), "agent v1\nUSER EDIT");
});

test("copyIfNewer: identical files are not rewritten", () => {
  const src = file("c5/src.txt", "same", 50);
  const dest = file("c5/dest.txt", "same", 50);
  assert.equal(copyIfNewer(src, mtimeOf(src), dest), false);
});

test("copyIfNewer: copying a file onto itself is a no-op; a missing source fails safe", () => {
  const f = file("c6/f.txt", "x", 5);
  assert.equal(copyIfNewer(f, mtimeOf(f), f), false);
  assert.equal(copyIfNewer(path.join(SANDBOX, "nope"), Date.now(), path.join(SANDBOX, "sync", "c6", "d.txt")), false);
});

test("getRootDirTrackedFiles: includes repository tracked files and excludes uncommitted untracked files", () => {
  const tracked = getRootDirTrackedFiles();
  assert.ok(tracked instanceof Set, "must return a Set");
  assert.ok(tracked.has("Cargo.toml") || tracked.has("README.md") || tracked.has("app.py"), "must include tracked root files");
  assert.equal(tracked.has(".git"), false, ".git directory must not be in tracked files");
  assert.equal(tracked.has("nonexistent_random_canary_file.txt"), false);
});

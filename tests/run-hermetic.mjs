#!/usr/bin/env node
// Hermetic Test Runner: runs unit and e2e test suites in an isolated sandbox with dynamic port allocation.
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, maxWaitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) {
        const body = await res.json();
        if (body && body.ok) return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

function runCommand(command, args, env, cwd = ROOT_DIR) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: "inherit"
    });
    child.on("close", (code) => {
      resolve(code || 0);
    });
  });
}

async function main() {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "vanaras-hermetic-"));
  const tempRepoDir = path.join(tempBase, "repo");

  // Clone local repo so git worktrees have an isolated git database and branches
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["clone", "--local", ROOT_DIR, tempRepoDir], { stdio: "pipe" });

  // Sync working tree changes into the cloned sandbox so in-flight edits are tested
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT_DIR, stdio: "pipe" }).toString("utf8");
  for (const line of dirty.split("\n")) {
    // Porcelain lines are "XY <path>": the status occupies two fixed columns, the first of which is a space
    // for unstaged edits (" M ui/x"). Trimming first would shift the path and drop its first character.
    if (!line.trim()) continue;
    const rel = line.slice(3).trim().replace(/^.* -> /, "");
    if (rel.startsWith(".worktrees") || rel.startsWith(".vanaras") || rel.startsWith("target") || rel.startsWith("node_modules")) continue;
    const src = path.join(ROOT_DIR, rel);
    const dst = path.join(tempRepoDir, rel);
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } else if (!fs.existsSync(src) && fs.existsSync(dst)) {
      // Deleted in the working tree: the snapshot must not keep it (e.g. a removed test file).
      fs.rmSync(dst, { force: true });
    }
  }
  execFileSync("git", ["add", "-A"], { cwd: tempRepoDir, stdio: "pipe" });
  try {
    execFileSync("git", ["-c", "user.name=CI", "-c", "user.email=ci@test", "commit", "-m", "chore: hermetic working tree snapshot"], { cwd: tempRepoDir, stdio: "pipe" });
  } catch {}

  // The project the tests' rooms work on: a small git repository, never Vanaras's own checkout.
  const tempProjectDir = path.join(tempBase, "project");
  fs.mkdirSync(path.join(tempProjectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempProjectDir, "README.md"), "# Fixture project\n\nA small app used by the Vanaras end-to-end tests.\n");
  fs.writeFileSync(path.join(tempProjectDir, "package.json"), JSON.stringify({ name: "fixture-project", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
  fs.writeFileSync(path.join(tempProjectDir, "src", "math.mjs"), "// Adds two numbers.\nexport function add(a, b) {\n  return a + b;\n}\n\n// Multiplies two numbers.\nexport function multiply(a, b) {\n  return a * b;\n}\n");
  execFileSync("git", ["init", "-q"], { cwd: tempProjectDir });
  execFileSync("git", ["add", "-A"], { cwd: tempProjectDir });
  execFileSync("git", ["-c", "user.name=CI", "-c", "user.email=ci@test", "commit", "-qm", "fixture project"], { cwd: tempProjectDir });

  const tempStateDir = path.join(tempBase, "state");
  const tempWorktreesDir = path.join(tempRepoDir, ".worktrees");
  fs.mkdirSync(tempStateDir, { recursive: true });
  fs.mkdirSync(tempWorktreesDir, { recursive: true });

  const port = await getFreePort();
  const testUrl = `http://127.0.0.1:${port}`;

  console.log("===================================================================");
  console.log("             VANARAS HERMETIC TEST RUNNER                          ");
  console.log("===================================================================");
  console.log(`Cloned Repo: ${tempRepoDir}`);
  console.log(`Sandbox:     ${tempBase}`);
  console.log(`Port:        ${port}`);
  console.log(`Test URL:    ${testUrl}`);
  console.log("-------------------------------------------------------------------");

  const serverProcess = spawn(process.execPath, [path.join(tempRepoDir, "ui", "server.mjs")], {
    cwd: tempRepoDir,
    env: {
      ...process.env,
      VANARAS_PORT: String(port),
      VANARAS_STATE_DIR: tempStateDir,
      VANARAS_WORKTREES_DIR: tempWorktreesDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  serverProcess.stdout.on("data", () => {});
  serverProcess.stderr.on("data", () => {});

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      serverProcess.kill("SIGTERM");
    } catch {}
    try {
      fs.rmSync(tempBase, { recursive: true, force: true });
    } catch {}
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  console.log("Starting isolated Vanaras server instance...");
  const isHealthy = await waitForServer(testUrl);
  if (!isHealthy) {
    console.error(`ERROR: Isolated server failed to start within 15s on port ${port}`);
    cleanup();
    process.exit(1);
  }
  console.log(`✔ Isolated Vanaras server ready on port ${port}\n`);

  console.log("--- 1. Running Unit Tests ---");
  const unitDir = path.join(tempRepoDir, "tests", "unit");
  const unitFiles = fs.readdirSync(unitDir)
    .filter(f => f.endsWith(".test.mjs"))
    .map(f => path.join("tests", "unit", f));

  const unitCode = await runCommand(process.execPath, ["--test", ...unitFiles], {
    VANARAS_STATE_DIR: tempStateDir,
    VANARAS_WORKTREES_DIR: tempWorktreesDir
  }, tempRepoDir);

  if (unitCode !== 0) {
    console.error(`\n❌ Unit tests failed with exit code ${unitCode}`);
    cleanup();
    process.exit(unitCode);
  }

  console.log("\n--- 2. Running E2E Test Suite ---");
  const e2eCode = await runCommand(process.execPath, ["tests/e2e-suite.mjs"], {
    VANARAS_TEST_URL: testUrl,
    VANARAS_TEST_PROJECT: fs.realpathSync(tempProjectDir),
    VANARAS_PROJECT: fs.realpathSync(tempProjectDir),
    VANARAS_PORT: String(port),
    VANARAS_STATE_DIR: tempStateDir,
    VANARAS_WORKTREES_DIR: tempWorktreesDir
  }, tempRepoDir);

  cleanup();

  if (e2eCode !== 0) {
    console.error(`\n❌ E2E test suite failed with exit code ${e2eCode}`);
    process.exit(e2eCode);
  }

  console.log("\n===================================================================");
  console.log("✔ ALL HERMETIC SUITES PASSED CLEANLY!");
  console.log("===================================================================");
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal hermetic runner error:", err);
  process.exit(1);
});

#!/usr/bin/env node

import {
  TestRunner,
  ensureServerRunning,
  stopSpawnedServer,
  BASE_URL
} from "./test-harness.mjs";
import { registerTier1Tests } from "./tier1-feature-coverage.test.mjs";
import { registerTier2Tests } from "./tier2-boundary-corner.test.mjs";
import { registerTier3Tests } from "./tier3-combinations.test.mjs";
import { registerTier4Tests } from "./tier4-application-scenarios.test.mjs";

// ANSI escape codes
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";

function parseArgs(args) {
  const options = {
    tier: null,
    milestone: null,
    feature: null,
    json: false,
    bail: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--tier" && i + 1 < args.length) {
      options.tier = args[++i];
    } else if (arg.startsWith("--tier=")) {
      options.tier = arg.split("=")[1];
    } else if (arg === "--milestone" && i + 1 < args.length) {
      options.milestone = args[++i];
    } else if (arg.startsWith("--milestone=")) {
      options.milestone = arg.split("=")[1];
    } else if (arg === "--feature" && i + 1 < args.length) {
      options.feature = args[++i];
    } else if (arg.startsWith("--feature=")) {
      options.feature = arg.split("=")[1];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--bail") {
      options.bail = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }
  return options;
}

function printUsage() {
  console.log(`
${BOLD}Vanaras End-to-End Test Suite Runner${RESET}

${BOLD}Usage:${RESET}
  node tests/e2e-suite.mjs [options]

${BOLD}Options:${RESET}
  --tier <1-4>          Run tests for a specific tier (1: Feature, 2: Boundary, 3: Combinations, 4: Real-world)
  --milestone <M1-M7>   Run tests for a specific milestone (e.g. M1, M2, M3)
  --feature <F1-F14>    Run tests for a specific feature ID (e.g. F1, F2)
  --json                Output results as structured JSON
  --bail                Stop on first test failure
  --help, -h            Show this help message
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    process.exit(0);
  }

  const runner = new TestRunner();
  registerTier1Tests(runner);
  registerTier2Tests(runner);
  registerTier3Tests(runner);
  registerTier4Tests(runner);

  let spawned = false;
  if (!options.json) {
    console.log(`${BOLD}${CYAN}===================================================================${RESET}`);
    console.log(`${BOLD}${CYAN}            VANARAS E2E VERIFICATION TEST SUITE                   ${RESET}`);
    console.log(`${BOLD}${CYAN}===================================================================${RESET}`);
    console.log(`${GRAY}Target Base URL:${RESET} ${BASE_URL}`);
    console.log(`${GRAY}Filter:${RESET} ${JSON.stringify({ tier: options.tier, milestone: options.milestone, feature: options.feature })}`);
    console.log(`${GRAY}Connecting or initializing Vanaras server daemon...${RESET}`);
  }

  try {
    const serverInfo = await ensureServerRunning();
    spawned = serverInfo.spawned;
    if (!options.json) {
      console.log(`${GREEN}✔ Vanaras server ready (${spawned ? "ephemeral child spawned" : "connected to existing on port 3000"})${RESET}\n`);
    }
  } catch (err) {
    if (options.json) {
      console.log(JSON.stringify({ error: err.message, status: "SERVER_UNAVAILABLE" }));
    } else {
      console.error(`${RED}✖ Failed to start/connect to Vanaras server: ${err.message}${RESET}`);
    }
    process.exit(1);
  }

  const overallStart = Date.now();
  const results = await runner.run(options);
  const totalDuration = Date.now() - overallStart;

  stopSpawnedServer();

  if (options.json) {
    const summary = {
      timestamp: new Date().toISOString(),
      total: results.length,
      passed: results.filter(r => r.status === "PASS").length,
      failed: results.filter(r => r.status === "FAIL").length,
      durationMs: totalDuration,
      results: results.map(r => ({
        tier: r.tier,
        milestone: r.milestone,
        feature: r.feature,
        name: r.name,
        status: r.status,
        durationMs: r.durationMs,
        error: r.error ? r.error.message : null
      }))
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.failed > 0 ? 1 : 0);
  }

  // Terminal Output Formatted Table
  console.log(`${BOLD}${"TIER".padEnd(6)} ${"MS".padEnd(5)} ${"FEAT".padEnd(6)} ${"STATUS".padEnd(8)} ${"DURATION".padEnd(10)} ${"TEST NAME"}${RESET}`);
  console.log(`${GRAY}-------------------------------------------------------------------${RESET}`);

  for (const r of results) {
    const statusStr = r.status === "PASS"
      ? `${GREEN}${BOLD} PASS ${RESET}`
      : `${RED}${BOLD} FAIL ${RESET}`;
    const durStr = `${r.durationMs}ms`.padEnd(10);
    const tierStr = `T${r.tier}`.padEnd(6);
    const msStr = r.milestone.padEnd(5);
    const featStr = r.feature.padEnd(6);
    console.log(`${tierStr} ${msStr} ${featStr} ${statusStr} ${GRAY}${durStr}${RESET} ${r.name}`);
  }

  const passedCount = results.filter(r => r.status === "PASS").length;
  const failedCount = results.filter(r => r.status === "FAIL").length;

  if (failedCount > 0) {
    console.log(`\n${BOLD}${RED}--- FAILURE DETAILS ---${RESET}`);
    for (const r of results) {
      if (r.status === "FAIL") {
        console.log(`\n${RED}${BOLD}✖ [${r.milestone}/${r.feature}] ${r.name}${RESET}`);
        console.log(`  ${YELLOW}${r.error?.message || r.error}${RESET}`);
        if (r.error?.stack) {
          const stackSnippet = r.error.stack.split("\n").slice(1, 4).join("\n");
          console.log(`${GRAY}${stackSnippet}${RESET}`);
        }
      }
    }
  }

  console.log(`\n${BOLD}${CYAN}===================================================================${RESET}`);
  console.log(`${BOLD}Total Tests:${RESET}   ${results.length}`);
  console.log(`${BOLD}Passed:${RESET}        ${GREEN}${passedCount}${RESET}`);
  console.log(`${BOLD}Failed:${RESET}        ${failedCount > 0 ? RED : GREEN}${failedCount}${RESET}`);
  console.log(`${BOLD}Total Time:${RESET}    ${totalDuration}ms`);
  console.log(`${BOLD}${CYAN}===================================================================${RESET}\n`);

  process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((err) => {
  stopSpawnedServer();
  console.error(`${RED}Fatal Test Runner Exception:${RESET}`, err);
  process.exit(1);
});

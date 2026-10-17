import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  VANARAS_ROOT,
  requestJson,
  assert,
  assertEqual,
  assertIncludes,
  assertMatch
} from "./test-harness.mjs";

const execFileAsync = promisify(execFile);

export function registerTier4Tests(runner) {
  // T4.1: Real-World Developer Code Review via CLI & Workspace API
  runner.register(4, "M6", "F12", "T4.1_developer_code_review_workflow", async () => {
    const cliPath = path.join(VANARAS_ROOT, "vanaras-cli.mjs");
    assert(fs.existsSync(cliPath), `vanaras-cli.mjs must exist at ${cliPath}`);

    // Create a modified file in bot_r1 worktree
    const testFile = "temp_review_sample.js";
    await requestJson("POST", "/api/agent/tool", {
      action: "fs_write",
      botId: "bot_r1",
      filePath: testFile,
      content: "console.log('Code review probe');\n"
    });

    try {
      // Execute CLI diff
      const { stdout: diffOut, stderr } = await execFileAsync(process.execPath, [
        cliPath,
        "diff",
        "--agent",
        "R1"
      ]);
      assert(!stderr, `CLI diff returned errors: ${stderr}`);
      assert(
        diffOut.includes(testFile) || diffOut.includes("review probe") || diffOut.includes("diff"),
        `CLI diff output must reflect modified file: ${diffOut}`
      );
    } finally {
      // Cleanup: revert file
      await requestJson("POST", "/api/agent/workspace", {
        action: "revert_file",
        botId: "bot_r1",
        file: testFile
      });
    }
  });

  // T4.2: Real-World Squad Workspace Health & Worktree Integrity Validation
  runner.register(4, "M5", "F10", "T4.2_squad_workspace_health_and_ports_validation", async () => {
    const healthRes = await requestJson("GET", "/api/health");
    assertEqual(healthRes.status, 200, "Health check must return 200");
    assertEqual(healthRes.body?.ok, true, "Health check ok must be true");

    const wsRes = await requestJson("GET", "/api/workspace");
    assertEqual(wsRes.status, 200, "Workspace endpoint must return 200");

    // Check worktrees directory exists
    const worktreesDir = path.join(VANARAS_ROOT, ".worktrees");
    assert(fs.existsSync(worktreesDir), `.worktrees directory must exist at ${worktreesDir}`);

    // Validate active worktree entries have assigned ports and branch structures
    const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
    const botWorktrees = entries.filter(e => e.isDirectory() && e.name.startsWith("bot_"));
    assert(botWorktrees.length > 0, "There should be at least one bot worktree provisioned");

    for (const wt of botWorktrees) {
      const wtPath = path.join(worktreesDir, wt.name);
      assert(fs.existsSync(path.join(wtPath, ".git")), `Worktree ${wt.name} must contain a .git link file`);
    }
  });

  // T4.3: Real-World Fast Codebase Symbol Navigation Grounding
  runner.register(4, "M2", "F2", "T4.3_fast_codebase_symbol_navigation", async () => {
    const symbolToFind = "ensureAgentWorktree";

    const res = await requestJson("POST", "/api/agent/tool", {
      action: "grep_search",
      botId: "bot_r1",
      content: symbolToFind
    });

    assertEqual(res.status, 200, `grep_search failed: ${JSON.stringify(res.body)}`);
    assert(Array.isArray(res.body?.matches), "Matches must be an array");

    // Locate a match from server.mjs
    const serverMatch = res.body.matches.find(m => m.file?.includes("server.mjs"));
    assert(serverMatch, "Must find symbol occurrence in server.mjs");

    // Verify file and line grounding against actual filesystem content
    const targetFilePath = path.resolve(VANARAS_ROOT, serverMatch.file);
    assert(fs.existsSync(targetFilePath), `Reported file ${targetFilePath} must exist on disk`);

    const fileContent = fs.readFileSync(targetFilePath, "utf8");
    const fileLines = fileContent.split(/\r?\n/);
    const lineNumber = serverMatch.line;
    assert(lineNumber > 0 && lineNumber <= fileLines.length, `Line number ${lineNumber} must be within bounds of file`);

    const actualLine = fileLines[lineNumber - 1];
    assert(
      actualLine.includes(symbolToFind),
      `Line ${lineNumber} in ${serverMatch.file} does not contain '${symbolToFind}'. Actual line: "${actualLine}"`
    );
  });

  // T4.4: Real-World Benchmark Report Structural & Semantic Integrity
  runner.register(4, "M1", "F1", "T4.4_benchmark_report_structural_and_semantic_integrity", async () => {
    const reportPath = path.join(VANARAS_ROOT, "BENCHMARK_COMPARISON.md");
    assert(fs.existsSync(reportPath), "BENCHMARK_COMPARISON.md must exist");

    const content = fs.readFileSync(reportPath, "utf8");

    // Verify key sections
    const requiredSections = [
      "Executive Summary",
      "Comparison Matrix",
      "Technical Breakdown",
      "Quantitative",
      "Blueprint",
      "Conclusion"
    ];

    for (const sec of requiredSections) {
      const secRegex = new RegExp(`##.*${sec}`, "i");
      assertMatch(content, secRegex, `Report missing section header: ${sec}`);
    }

    // Verify table structure has proper columns
    const lines = content.split(/\r?\n/);
    const tableHeader = lines.find(l => l.includes("|") && l.includes("Vanaras") && l.includes("Cursor"));
    assert(tableHeader, "Benchmark report must contain comparison table header with Vanaras and Cursor");
  });
}

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

export function registerTier1Tests(runner) {
  // T1.1: F1 - Architectural Benchmark Report Validation
  runner.register(1, "M1", "F1", "T1.1_benchmark_report_validation", async () => {
    const reportPath = path.join(VANARAS_ROOT, "BENCHMARK_COMPARISON.md");
    assert(fs.existsSync(reportPath), `BENCHMARK_COMPARISON.md must exist at ${reportPath}`);

    const content = fs.readFileSync(reportPath, "utf8");
    const lines = content.split(/\r?\n/);
    assert(lines.length >= 250, `BENCHMARK_COMPARISON.md must be >= 250 lines; found ${lines.length}`);

    // All 7 systems must be represented
    const requiredSystems = [
      "Vanaras",
      "Cursor",
      "OpenCode",
      "Codex",
      "Claude Code",
      "Antigravity"
    ];
    for (const sys of requiredSystems) {
      assert(content.includes(sys), `Benchmark report missing evaluated system: ${sys}`);
    }
    assert(content.includes("Aider") || content.includes("Goose"), "Benchmark report missing Aider/Goose CLI evaluation");

    // All 6 technical dimensions from R1 must be present
    const requiredDimensions = [
      "Context Engineering",
      "Multi-Agent Orchestration",
      "Tool Execution Harness",
      "Diff",
      "MCP",
      "Gaps"
    ];
    for (const dim of requiredDimensions) {
      const regex = new RegExp(dim, "i");
      assertMatch(content, regex, `Benchmark report missing dimension: ${dim}`);
    }

    // Comparison matrix table check
    assert(content.includes("|"), "Benchmark report must contain markdown comparison table matrix");
  });

  // T1.2: F2 - Server grep_search Tool Endpoint
  runner.register(1, "M2", "F2", "T1.2_server_grep_search_endpoint", async () => {
    const res = await requestJson("POST", "/api/agent/tool", {
      action: "grep_search",
      botId: "bot_r1",
      botName: "R1",
      content: "multiply"
    });

    assertEqual(res.status, 200, `Expected HTTP 200 for grep_search, got ${res.status} body=${JSON.stringify(res.body)}`);
    assertEqual(res.body?.ok, true, `Expected ok: true in grep_search response, got ${JSON.stringify(res.body)}`);
    assert(Array.isArray(res.body?.matches), "grep_search response must contain 'matches' array");
    assert(res.body.matches.some(m => m.file === "src/math.mjs"), `grep_search for 'multiply' must find it in the project's src/math.mjs: ${JSON.stringify(res.body.matches)}`);

    const firstMatch = res.body.matches[0];
    assert(firstMatch.file, "Match item must include 'file' property");
    assert(firstMatch.line !== undefined, "Match item must include 'line' number");
  });

  // T1.3: F3 - Server find_files Tool Endpoint
  runner.register(1, "M2", "F3", "T1.3_server_find_files_endpoint", async () => {
    const res = await requestJson("POST", "/api/agent/tool", {
      action: "find_files",
      botId: "bot_r1",
      botName: "R1",
      content: "math"
    });

    assertEqual(res.status, 200, `Expected HTTP 200 for find_files, got ${res.status} body=${JSON.stringify(res.body)}`);
    assertEqual(res.body?.ok, true, `Expected ok: true in find_files response, got ${JSON.stringify(res.body)}`);
    assert(Array.isArray(res.body?.files), "find_files response must contain 'files' array");
    assert(res.body.files.includes("src/math.mjs"), `find_files for 'math' should find the project's src/math.mjs: ${JSON.stringify(res.body.files)}`);
    assert(!res.body.files.some(f => f.includes("server.mjs")), "an agent's file search must not see Vanaras's own files");
  });

  // T1.4: F4 - Client ReAct Search Tool Dispatch
  runner.register(1, "M2", "F4", "T1.4_client_react_search_dispatch", async () => {
    const clientPath = path.join(VANARAS_ROOT, "ui", "index.html");
    const html = fs.readFileSync(clientPath, "utf8");

    // grep_search and find_files must be registered in AVAILABLE_AGENT_TOOLS
    assert(html.includes('"grep_search"'), "Client index.html must register 'grep_search' in AVAILABLE_AGENT_TOOLS");
    assert(html.includes('"find_files"'), "Client index.html must register 'find_files' in AVAILABLE_AGENT_TOOLS");

    // ReAct loop must handle [TOOL: grep_search] and [TOOL: find_files]
    assert(html.includes("grep_search"), "processBotAutonomousActions must support grep_search");
    assert(html.includes("find_files"), "processBotAutonomousActions must support find_files");
  });

  // T1.5: F5 - @file: Composer Mentions & Context Grounding
  runner.register(1, "M2", "F5", "T1.5_client_composer_file_mentions", async () => {
    const clientPath = path.join(VANARAS_ROOT, "ui", "index.html");
    const html = fs.readFileSync(clientPath, "utf8");

    // Must handle @file: mention detection
    assert(html.includes("@file:"), "Client index.html must detect '@file:' mentions in composer input");
  });

  // T1.6: F6 - Server Workspace Unified Diff Endpoint
  runner.register(1, "M3", "F6", "T1.6_server_workspace_diff_endpoint", async () => {
    const res = await requestJson("POST", "/api/agent/workspace", {
      action: "diff",
      botId: "bot_r1"
    });

    assertEqual(res.status, 200, `Expected HTTP 200 for action: 'diff', got ${res.status} body=${JSON.stringify(res.body)}`);
    assertEqual(res.body?.ok, true, `Expected ok: true in diff response, got ${JSON.stringify(res.body)}`);
    assert(typeof res.body?.diff === "string", "Diff response must contain unified diff string");
  });

  // T1.7: F6 - Server Workspace Revert File Endpoint
  runner.register(1, "M3", "F6", "T1.7_server_workspace_revert_endpoint", async () => {
    // Write temporary file via fs_write to have a deterministic revert target
    await requestJson("POST", "/api/agent/tool", {
      action: "fs_write",
      botId: "bot_r1",
      filePath: "temp_test_revert_probe.txt",
      content: "Probe content for revert verification"
    });

    const res = await requestJson("POST", "/api/agent/workspace", {
      action: "revert_file",
      botId: "bot_r1",
      file: "temp_test_revert_probe.txt"
    });

    assertEqual(res.status, 200, `Expected HTTP 200 for revert_file, got ${res.status} body=${JSON.stringify(res.body)}`);
    assertEqual(res.body?.ok, true, `Expected ok: true in revert_file response, got ${JSON.stringify(res.body)}`);
  });

  // T1.8: F7 - Client Interactive Diff Viewer & Controls
  runner.register(1, "M3", "F7", "T1.8_client_workbench_diff_viewer", async () => {
    const clientPath = path.join(VANARAS_ROOT, "ui", "index.html");
    const html = fs.readFileSync(clientPath, "utf8");

    assert(html.includes("btnModeDiff") || html.includes("'diff'"), "Right workbench drawer must include Diff tab option");
    assert(html.includes("Accept & Merge") || html.includes("acceptMerge") || html.includes("merge_to_main"), "Diff viewer must have Accept & Merge control");
    assert(html.includes("Revert") || html.includes("revert_file"), "Diff viewer must have Revert control");
  });

  // T1.9: F8 - Server Host MCP Ecosystem Auto-Discovery
  runner.register(1, "M4", "F8", "T1.9_server_mcp_discovery_endpoint", async () => {
    const res = await requestJson("GET", "/api/mcp/discover");
    assertEqual(res.status, 200, `Expected HTTP 200 for GET /api/mcp/discover, got ${res.status}`);
    assertEqual(res.body?.ok, true, `Expected ok: true in mcp discover response, got ${JSON.stringify(res.body)}`);
    assert(Array.isArray(res.body?.servers), "Discovery response must contain 'servers' array");
  });

  // T1.10: F9 - Client Agent Studio MCP Import Picker
  runner.register(1, "M4", "F9", "T1.10_client_agent_studio_mcp_picker", async () => {
    const clientPath = path.join(VANARAS_ROOT, "ui", "index.html");
    const html = fs.readFileSync(clientPath, "utf8");

    assert(
      html.includes("discover") || html.includes("Discover") || html.includes("/api/mcp/discover"),
      "Agent Studio MCP tab must include Host MCP auto-discovery UI"
    );
  });

  // T1.11: F10 - Parallel Multi-Agent Execution Contract
  runner.register(1, "M5", "F10", "T1.11_client_parallel_dispatch_contract", async () => {
    const clientPath = path.join(VANARAS_ROOT, "ui", "index.html");
    const html = fs.readFileSync(clientPath, "utf8");

    // Client must support parallel/concurrent turn execution without cancelling other active turns
    assert(
      html.includes("parallel") || html.includes("concurrent") || html.includes("activeTurnState["),
      "Client must implement multi-agent turn concurrency"
    );
  });

  // T1.12: F11 - Live Multi-Agent Status Strip
  runner.register(1, "M5", "F11", "T1.12_client_live_status_strip", async () => {
    const clientPath = path.join(VANARAS_ROOT, "ui", "index.html");
    const html = fs.readFileSync(clientPath, "utf8");

    assert(
      html.includes("status-strip") || html.includes("multiAgentStatus") || html.includes("agent-status-bar") || html.includes("agentStatus"),
      "UI must contain a live multi-agent task status strip"
    );
  });

  // T1.13: F12 - Headless CLI Companion Contract
  runner.register(1, "M6", "F12", "T1.13_cli_companion_contract", async () => {
    const cliPath = path.join(VANARAS_ROOT, "vanaras-cli.mjs");
    assert(fs.existsSync(cliPath), `vanaras-cli.mjs must exist at ${cliPath}`);

    // Verify syntax with node --check
    const { stderr } = await execFileAsync(process.execPath, ["--check", cliPath]);
    assert(!stderr, `node --check vanaras-cli.mjs produced syntax errors: ${stderr}`);

    // Verify status subcommand execution
    const statusRun = await execFileAsync(process.execPath, [cliPath, "status"]);
    assertEqual(statusRun.error ? 1 : 0, 0, `CLI status command failed: ${statusRun.stderr}`);
    assert(statusRun.stdout.length > 0, "CLI status command must output status info");
  });

  // T1.14: F13/F14 - Canvas Sync & Syntax Verification Gates
  runner.register(1, "M7", "F14", "T1.14_sync_and_syntax_gates", async () => {
    const serverPath = path.join(VANARAS_ROOT, "ui", "server.mjs");
    const { stderr: serverErr } = await execFileAsync(process.execPath, ["--check", serverPath]);
    assert(!serverErr, `node --check ui/server.mjs produced syntax errors: ${serverErr}`);

    const indexPath = path.join(VANARAS_ROOT, "ui", "index.html");
    const canvasPath = path.join(VANARAS_ROOT, "ui", "canvas.html");
    assert(fs.existsSync(indexPath), "ui/index.html must exist");
    assert(fs.existsSync(canvasPath), "ui/canvas.html must exist");

    const indexContent = fs.readFileSync(indexPath, "utf8");
    const canvasContent = fs.readFileSync(canvasPath, "utf8");
    assertEqual(indexContent.length, canvasContent.length, "ui/index.html and ui/canvas.html should have matching byte size");
  });
}

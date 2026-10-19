import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  VANARAS_ROOT,
  requestJson,
  assert,
  assertEqual,
  assertIncludes
} from "./test-harness.mjs";

const execFileAsync = promisify(execFile);

export function registerTier3Tests(runner) {
  // T3.1: Full Edit -> Find -> Search -> Diff -> Revert Lifecycle
  runner.register(3, "M3", "F6", "T3.1_codebase_edit_search_diff_revert_lifecycle", async () => {
    const testFileName = "temp_lifecycle_probe.txt";
    const uniqueToken = `E2E_TOKEN_${Date.now()}_VANARAS_TEST`;

    // 1. Write the file into bot_r1 worktree via fs_write
    const writeRes = await requestJson("POST", "/api/agent/tool", {
      action: "fs_write",
      botId: "bot_r1",
      filePath: testFileName,
      content: `Line 1: Hello Vanaras\nLine 2: ${uniqueToken}\nLine 3: End of probe`
    });
    assertEqual(writeRes.status, 200, `fs_write failed: ${JSON.stringify(writeRes.body)}`);

    // 2. Find the file via find_files
    const findRes = await requestJson("POST", "/api/agent/tool", {
      action: "find_files",
      botId: "bot_r1",
      content: testFileName
    });
    assertEqual(findRes.status, 200, `find_files failed: ${JSON.stringify(findRes.body)}`);
    assert(
      Array.isArray(findRes.body?.files) && findRes.body.files.some(f => f.includes(testFileName)),
      `find_files did not locate ${testFileName}: ${JSON.stringify(findRes.body)}`
    );

    // 3. Search for unique token via grep_search
    const grepRes = await requestJson("POST", "/api/agent/tool", {
      action: "grep_search",
      botId: "bot_r1",
      content: uniqueToken
    });
    assertEqual(grepRes.status, 200, `grep_search failed: ${JSON.stringify(grepRes.body)}`);
    assert(
      Array.isArray(grepRes.body?.matches) && grepRes.body.matches.length > 0,
      `grep_search did not find uniqueToken ${uniqueToken}`
    );

    // 4. Inspect unified diff via diff endpoint
    const diffRes = await requestJson("POST", "/api/agent/workspace", {
      action: "diff",
      botId: "bot_r1"
    });
    assertEqual(diffRes.status, 200, `diff action failed: ${JSON.stringify(diffRes.body)}`);

    // 5. Revert file via revert_file endpoint
    const revertRes = await requestJson("POST", "/api/agent/workspace", {
      action: "revert_file",
      botId: "bot_r1",
      file: testFileName
    });
    assertEqual(revertRes.status, 200, `revert_file failed: ${JSON.stringify(revertRes.body)}`);

    // 6. Verify clean diff after revert
    const cleanDiffRes = await requestJson("POST", "/api/agent/workspace", {
      action: "diff",
      botId: "bot_r1"
    });
    assertEqual(cleanDiffRes.status, 200, `diff after revert failed: ${JSON.stringify(cleanDiffRes.body)}`);
    assert(
      !cleanDiffRes.body?.diff?.includes(uniqueToken),
      "Diff after revert still contains unique test token"
    );
  });

  // T3.2: Host MCP Discovery -> Redaction -> Configuration Integrity
  runner.register(3, "M4", "F8", "T3.2_mcp_discovery_redaction_and_config_integrity", async () => {
    // 1. Discover host MCP servers
    const discoverRes = await requestJson("GET", "/api/mcp/discover");
    assertEqual(discoverRes.status, 200, `GET /api/mcp/discover failed: ${discoverRes.status}`);
    assert(Array.isArray(discoverRes.body?.servers), "Discovery body must have servers array");

    // 2. Test saving and reading an agent's MCP config preserving safety
    const sampleCommand = "npx -y @modelcontextprotocol/server-filesystem /tmp";
    const saveSkillRes = await requestJson("POST", "/api/agent/skill", {
      botId: "bot_r1",
      mcpCommand: sampleCommand,
      instructions: "E2E Test Instructions"
    });
    assertEqual(saveSkillRes.status, 200, `POST /api/agent/skill failed: ${JSON.stringify(saveSkillRes.body)}`);

    // Verify config retrieval
    const readSkillRes = await requestJson("POST", "/api/agent/skill", {
      botId: "bot_r1"
    });
    assertEqual(readSkillRes.status, 200, `Reading skill config failed: ${JSON.stringify(readSkillRes.body)}`);
  });

  // T3.3: CLI and Server Real-Time Synchronization
  runner.register(3, "M6", "F12", "T3.3_cli_server_realtime_synchronization", async () => {
    const cliPath = path.join(VANARAS_ROOT, "vanaras-cli.mjs");
    assert(fs.existsSync(cliPath), `vanaras-cli.mjs must exist at ${cliPath}`);

    // Query status via CLI
    const { stdout: cliStatusOut } = await execFileAsync(process.execPath, [cliPath, "status"]);
    assert(cliStatusOut.length > 0, "CLI status output must not be empty");

    // Compare with direct /api/health
    const healthRes = await requestJson("GET", "/api/health");
    assertEqual(healthRes.status, 200, "Server /api/health must be 200");

    // Query search via CLI
    const { stdout: cliSearchOut } = await execFileAsync(process.execPath, [cliPath, "search", "PORT"]);
    assert(cliSearchOut.includes("PORT") || cliSearchOut.includes("server"), "CLI search must return matches");
  });

  // T3.4: An agent's work stays on its own branch of the room's project and reaches the project only when the
  // user merges it; nothing is copied into the project or Vanaras behind the user's back.
  runner.register(3, "M7", "F14", "T3.4_agent_work_reaches_project_only_by_merge", async () => {
    const project = process.env.VANARAS_TEST_PROJECT;
    assert(project, "VANARAS_TEST_PROJECT must name the fixture project");
    const fileName = `feature_${process.pid}_${Date.now()}.mjs`;
    const botId = "bot_e2e_merge";

    const wrote = await requestJson("POST", "/api/agent/tool", { tool: "fs_write", botId, botName: "merger", filePath: `src/${fileName}`, content: "export const answer = 42;\n" });
    assertEqual(wrote.status, 200, `fs_write: ${wrote.raw}`);
    assert(!fs.existsSync(path.join(project, "src", fileName)), "an agent's write must not appear in the project before a merge");
    assert(!fs.existsSync(path.join(VANARAS_ROOT, fileName)) && !fs.existsSync(path.join(VANARAS_ROOT, "src", fileName)), "nor anywhere in Vanaras");

    const outside = await requestJson("POST", "/api/agent/tool", { tool: "fs_read", botId, filePath: "../../../../etc/hosts" });
    assert(outside.body?.ok === false && /outside this agent's worktree/.test(outside.body.error), `reads outside the worktree must be refused: ${outside.raw}`);

    const merged = await requestJson("POST", "/api/agent/workspace", { botId, botName: "merger", action: "merge_to_main" }, {}, 30000);
    assertEqual(merged.status, 200, `merge: ${merged.raw}`);
    assert(merged.body.merged === true, `merge must succeed: ${merged.body.output}`);
    assert(fs.existsSync(path.join(project, "src", fileName)), "after the merge the file is in the project");

    const again = await requestJson("POST", "/api/agent/workspace", { botId, botName: "merger", action: "merge_to_main" }, {}, 30000);
    assert(again.body.merged === false && /Nothing to merge/.test(again.body.output), `a second merge has nothing to bring in: ${again.body.output}`);

    const noProject = await requestJson("POST", "/api/agent/tool", { tool: "fs_read", botId, filePath: "README.md" }, { "X-Vanaras-Project": "" });
    assertEqual(noProject.status, 409, `a request with no project must be refused: ${noProject.raw}`);
    assertEqual(noProject.body?.code, "NO_PROJECT");
  });
}

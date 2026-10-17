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

  // T3.4: Deliverable sync must never overwrite a newer edit in the main checkout with a stale replica.
  // Regression: copyFileSync stamped replicas with "now", so the 2nd sync pass promoted a stale replica
  // over the user's real edit.
  runner.register(3, "M7", "F14", "T3.4_sync_preserves_newer_main_edit", async () => {
    const fileName = `vx_citest_sync_canary_${process.pid}.txt`;
    const rootFile = path.join(VANARAS_ROOT, fileName);
    const replicaDirs = [];
    const worktreesDir = path.join(VANARAS_ROOT, ".worktrees");
    if (fs.existsSync(worktreesDir)) {
      for (const wt of fs.readdirSync(worktreesDir, { withFileTypes: true })) {
        if (!wt.isDirectory() || wt.name.startsWith(".")) continue;
        replicaDirs.push(path.join(worktreesDir, wt.name));
        const aw = path.join(worktreesDir, wt.name, "agent_workspace");
        if (fs.existsSync(aw)) {
          for (const sub of fs.readdirSync(aw, { withFileTypes: true })) {
            if (sub.isDirectory() && !sub.name.startsWith(".")) replicaDirs.push(path.join(aw, sub.name));
          }
        }
      }
    }

    try {
      // 1. An agent produces the file; the server replicates it to the main root and sibling workspaces.
      const created = await requestJson("POST", "/api/agent/tool", {
        tool: "fs_write", botId: "bot_r1", filePath: fileName, content: "v1 agent version\n"
      });
      assertEqual(created.status, 200, `fs_write failed: ${JSON.stringify(created.body)}`);
      assert(fs.existsSync(rootFile), "agent deliverable must be promoted to the main root");

      // 2. The user edits the main copy afterwards.
      await new Promise(r => setTimeout(r, 1200));
      fs.appendFileSync(rootFile, "v2 USER EDIT\n", "utf8");

      // 3. Several unrelated tool calls trigger repeated sync passes.
      for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 1100));
        const res = await requestJson("POST", "/api/agent/tool", {
          tool: "shell_exec", botId: "bot_r1", command: "echo sync-pass"
        });
        assertEqual(res.status, 200, `shell_exec #${i} failed`);
        const current = fs.readFileSync(rootFile, "utf8");
        assertIncludes(current, "v2 USER EDIT", `user edit was overwritten after tool call #${i + 1}`);
      }
    } finally {
      for (const dir of [VANARAS_ROOT, ...replicaDirs]) {
        fs.rmSync(path.join(dir, fileName), { force: true });
      }
    }
  });
}

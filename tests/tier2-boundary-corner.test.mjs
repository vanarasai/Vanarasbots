import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  VANARAS_ROOT,
  requestJson,
  assert,
  assertEqual,
  assertIncludes
} from "./test-harness.mjs";

export function registerTier2Tests(runner) {
  // T2.1: grep_search with empty search pattern
  runner.register(2, "M2", "F2", "T2.1_grep_search_empty_pattern", async () => {
    const res = await requestJson("POST", "/api/agent/tool", {
      action: "grep_search",
      botId: "bot_r1",
      content: ""
    });

    // Server must respond gracefully (either 400 with error message or 200 with empty matches), never 500 crash
    assert(
      res.status === 400 || (res.status === 200 && Array.isArray(res.body?.matches) && res.body.matches.length === 0),
      `Empty grep pattern must be handled gracefully: status=${res.status} body=${JSON.stringify(res.body)}`
    );
  });

  // T2.2: grep_search with invalid regex special characters
  runner.register(2, "M2", "F2", "T2.2_grep_search_invalid_regex", async () => {
    const res = await requestJson("POST", "/api/agent/tool", {
      action: "grep_search",
      botId: "bot_r1",
      content: "[a-z(unclosed_bracket",
      isRegex: true
    });

    // Must handle regex parse errors gracefully, not crash or return uncaught 500
    assert(
      res.status === 400 || res.status === 200,
      `Invalid regex must return clean error status, got ${res.status}`
    );
    if (res.status === 400) {
      assert(res.body?.error, "Expected error explanation in 400 response for invalid regex");
    }
  });

  // T2.3: grep_search path traversal attempt
  runner.register(2, "M2", "F2", "T2.3_grep_search_path_traversal", async () => {
    const res = await requestJson("POST", "/api/agent/tool", {
      action: "grep_search",
      botId: "bot_r1",
      content: "root",
      path: "../../../../../../../../../etc"
    });

    // Path traversal outside workspace must be blocked (either 400 error or ok: false)
    assert(
      res.status === 400 || res.body?.ok === false || (res.body?.matches && res.body.matches.length === 0),
      `Path traversal in grep_search must be blocked: status=${res.status} body=${JSON.stringify(res.body)}`
    );
  });

  // T2.4: find_files with empty query and extreme wildcards
  runner.register(2, "M2", "F3", "T2.4_find_files_empty_and_special_chars", async () => {
    const resEmpty = await requestJson("POST", "/api/agent/tool", {
      action: "find_files",
      botId: "bot_r1",
      content: ""
    });
    assert(
      resEmpty.status === 400 || resEmpty.status === 200,
      `Empty find_files query must be handled without crash: got ${resEmpty.status}`
    );

    const resWildcard = await requestJson("POST", "/api/agent/tool", {
      action: "find_files",
      botId: "bot_r1",
      content: "******************"
    });
    assert(
      resWildcard.status === 400 || resWildcard.status === 200,
      `Extreme wildcard in find_files must not hang or crash: got ${resWildcard.status}`
    );
  });

  // T2.5: find_files path traversal attempt
  runner.register(2, "M2", "F3", "T2.5_find_files_path_traversal", async () => {
    const res = await requestJson("POST", "/api/agent/tool", {
      action: "find_files",
      botId: "bot_r1",
      content: "../../../../../etc/*"
    });

    assert(
      res.status === 400 || res.body?.ok === false || (Array.isArray(res.body?.files) && res.body.files.every(f => !f.startsWith("/etc") && !f.includes("../etc"))),
      `Path traversal in find_files must be blocked: status=${res.status} body=${JSON.stringify(res.body)}`
    );
  });

  // T2.6: diff on a clean worktree
  runner.register(2, "M3", "F6", "T2.6_diff_clean_worktree", async () => {
    const res = await requestJson("POST", "/api/agent/workspace", {
      action: "diff",
      botId: "bot_r1"
    });

    assertEqual(res.status, 200, `Expected HTTP 200 for clean diff, got ${res.status}`);
    assertEqual(res.body?.ok, true, `Expected ok: true for clean diff, got ${JSON.stringify(res.body)}`);
    assert(typeof res.body?.diff === "string", "Diff output should be a string even when empty");
  });

  // T2.7: revert_file on non-existent file or outside worktree
  runner.register(2, "M3", "F6", "T2.7_revert_nonexistent_file", async () => {
    const res = await requestJson("POST", "/api/agent/workspace", {
      action: "revert_file",
      botId: "bot_r1",
      file: "../../../../../etc/passwd"
    });

    assert(
      res.status === 400 || res.body?.ok === false,
      `Reverting system file / traversal must be rejected: status=${res.status} body=${JSON.stringify(res.body)}`
    );
  });

  // T2.8: Invalid / non-existent botId handling
  runner.register(2, "M2", "F2", "T2.8_invalid_bot_id_handling", async () => {
    const testBot = "bot_probe_invalid_id";
    try {
      const res = await requestJson("POST", "/api/agent/tool", {
        action: "grep_search",
        botId: testBot,
        content: "test"
      });

      assert(
        res.status === 200 || res.status === 400 || res.status === 404,
        `Invalid botId must return structured response, got ${res.status}`
      );
    } finally {
      const createdPath = path.join(VANARAS_ROOT, ".worktrees", testBot);
      if (fs.existsSync(createdPath)) {
        try { fs.rmSync(createdPath, { recursive: true, force: true }); } catch {}
      }
      try {
        execFileSync("git", ["worktree", "prune"], { cwd: VANARAS_ROOT, stdio: "ignore" });
        execFileSync("git", ["branch", "-D", "vanara/probe_invalid_id"], { cwd: VANARAS_ROOT, stdio: "ignore" });
      } catch {}
    }
  });

  // T2.9: MCP discovery secret redaction validation
  runner.register(2, "M4", "F8", "T2.9_mcp_secret_redaction_validation", async () => {
    const res = await requestJson("GET", "/api/mcp/discover");
    assertEqual(res.status, 200, `Expected HTTP 200 for /api/mcp/discover, got ${res.status}`);

    const serialized = JSON.stringify(res.body);

    // Assert that raw secret patterns never leak in plain text
    assert(!serialized.includes("sk-ant-"), "Discovered MCP response leaked Anthropic API key");
    assert(!serialized.includes("ghp_"), "Discovered MCP response leaked GitHub Personal Access Token");
    assert(!serialized.includes("AIzaSy"), "Discovered MCP response leaked Google API key");

    // Any env variables present should have values masked if they match sensitive keys
    if (Array.isArray(res.body?.servers)) {
      for (const server of res.body.servers) {
        if (server.env && typeof server.env === "object") {
          for (const [key, val] of Object.entries(server.env)) {
            const lowerKey = key.toLowerCase();
            if (lowerKey.includes("key") || lowerKey.includes("token") || lowerKey.includes("secret") || lowerKey.includes("password")) {
              assertEqual(val, "***REDACTED***", `Server ${server.name} env var ${key} must be masked as ***REDACTED***`);
            }
          }
        }
      }
    }
  });

  // T2.10: Malformed JSON requests
  runner.register(2, "M7", "F14", "T2.10_malformed_json_requests", async () => {
    const res = await requestJson("POST", "/api/agent/tool", "{ malformed_json: true, unterminated", {
      "Content-Type": "application/json"
    });

    assert(
      res.status === 400 || res.status === 500,
      `Malformed JSON should return HTTP 400 or 500 error response, got ${res.status}`
    );
  });

  // T2.11: find_files must honor the parameter shape advertised in the native tool schema (`query`)
  runner.register(2, "M2", "F3", "T2.11_find_files_honors_schema_query_param", async () => {
    const all = await requestJson("POST", "/api/agent/tool", { tool: "find_files", botId: "bot_r1" });
    assertEqual(all.status, 200, "unfiltered find_files must succeed");
    const searchRoot = all.body.searchRoot;
    assert(typeof searchRoot === "string" && fs.existsSync(searchRoot), "find_files must report an existing searchRoot");

    const needle = `vx_citest_findme_${process.pid}_${Date.now()}.txt`;
    const planted = path.join(searchRoot, needle);
    fs.writeFileSync(planted, "planted by T2.11\n", "utf8");
    try {
      for (const shape of [{ query: needle }, { args: { query: needle } }, { content: needle }]) {
        const res = await requestJson("POST", "/api/agent/tool", { tool: "find_files", botId: "bot_r1", ...shape });
        assertEqual(res.status, 200, `find_files ${JSON.stringify(shape)} must succeed`);
        assertEqual(JSON.stringify(res.body.files), JSON.stringify([needle]), `find_files ${JSON.stringify(shape)} must return exactly the planted file`);
      }
    } finally {
      fs.rmSync(planted, { force: true });
    }
  });

  // T2.12: grep_search must honor the parameter shape advertised in the native tool schema (`pattern`)
  runner.register(2, "M2", "F2", "T2.12_grep_search_honors_schema_pattern_param", async () => {
    const probe = await requestJson("POST", "/api/agent/tool", { tool: "grep_search", botId: "bot_r1", pattern: "ensureAgentWorktree" });
    const searchRoot = probe.body?.searchRoot;
    assert(typeof searchRoot === "string" && fs.existsSync(searchRoot), "grep_search must report an existing searchRoot");

    const marker = `VX_CITEST_MARKER_${process.pid}_${Date.now()}`;
    const fileName = "vx_citest_grep_marker.txt";
    const planted = path.join(searchRoot, fileName);
    fs.writeFileSync(planted, `line one\n${marker}\nline three\n`, "utf8");
    try {
      for (const shape of [{ pattern: marker }, { args: { pattern: marker } }, { content: marker }]) {
        const res = await requestJson("POST", "/api/agent/tool", { tool: "grep_search", botId: "bot_r1", ...shape });
        assertEqual(res.status, 200, `grep_search ${JSON.stringify(shape)} must succeed`);
        assertEqual(res.body.matches.length, 1, `grep_search ${JSON.stringify(shape)} must return exactly the planted line`);
        assertEqual(res.body.matches[0].file, fileName, "match must point at the planted file");
        assertEqual(res.body.matches[0].line, 2, "match must report the planted line number");
      }
    } finally {
      fs.rmSync(planted, { force: true });
    }
  });
}

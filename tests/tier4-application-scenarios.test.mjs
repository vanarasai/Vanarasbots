import fs from "node:fs";
import http from "node:http";
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

    // Verify file and line grounding against the tree that was actually searched. Paths are relative to
    // the agent's worktree (searchRoot), which can legitimately lag the main checkout.
    const searchRoot = res.body?.searchRoot;
    assert(typeof searchRoot === "string" && searchRoot.length > 0, "grep_search must report its searchRoot");
    const targetFilePath = path.resolve(searchRoot, serverMatch.file);
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

  // T4.5 / T4.6 drive the real server-side session runner against a scripted OpenAI-compatible model.
  // The script is chosen by the request's model id; each reply is consumed in order.
  async function withFakeModel(scripts, fn) {
    const seen = {};
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", async () => {
        if (!req.url.endsWith("/chat/completions")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [] }));
          return;
        }
        const payload = JSON.parse(body || "{}");
        (seen[payload.model] ||= []).push(payload.messages);
        const script = scripts[payload.model];
        const step = script.replies[Math.min(seen[payload.model].length - 1, script.replies.length - 1)];
        if (script.delayMs) await new Promise(r => setTimeout(r, script.delayMs));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: step.content || "", tool_calls: step.tool_calls } }] }));
      });
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    try {
      return await fn(`http://127.0.0.1:${server.address().port}/v1`, seen);
    } finally {
      server.close();
    }
  }

  async function configureFakeAgent(botId, baseUrl, model) {
    const r = await requestJson("POST", "/api/agent/skill", {
      botId, botName: botId, action: "set", skillMarkdown: "# test agent",
      agentConfig: { provider: "local", baseUrl, model, permissionPolicy: "auto" }
    });
    assertEqual(r.status, 200, `configuring ${botId}`);
  }

  async function waitForTurns(threadId, botIds, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const st = await requestJson("GET", "/api/sessions/status");
      const mine = (st.body.turns || []).filter(t => t.threadId === threadId && botIds.includes(t.botId));
      if (mine.length === botIds.length && mine.every(t => t.status !== "running")) return mine;
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`turns for ${botIds.join(", ")} did not finish within ${timeoutMs}ms`);
  }

  // T4.5: An agent that announces work without calling a tool is pushed to act, and the turn then runs the tool.
  runner.register(4, "M6", "F12", "T4.5_session_runner_pushes_announced_work_to_run", async () => {
    await withFakeModel({
      announcer: {
        replies: [
          { content: "Running full audio diagnostics now:" },
          { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "shell_exec", arguments: JSON.stringify({ command: "echo diag-ok" }) } }] },
          { content: "Diagnostics ran: the output was diag-ok." }
        ]
      }
    }, async (baseUrl, seen) => {
      const botId = "bot_e2e_announcer";
      const threadId = `thread_e2e_nudge_${Date.now()}`;
      await configureFakeAgent(botId, baseUrl, "announcer");
      const start = await requestJson("POST", "/api/sessions/turn", { threadId, botId, botName: "Announcer", prompt: "run diagnostics", maxSteps: 6 });
      assertEqual(start.status, 200, `turn start: ${start.raw}`);
      const [turn] = await waitForTurns(threadId, [botId]);
      assertEqual(turn.status, "completed", "turn must complete after the nudge");
      const st = await requestJson("GET", `/api/sessions/status?threadId=${encodeURIComponent(threadId)}`);
      const calls = st.body.turn.toolCalls || [];
      assert(calls.some(c => c.name === "shell_exec" && /diag-ok/.test(c.output)), `shell_exec must have run: ${JSON.stringify(calls)}`);
      assertMatch(st.body.turn.finalContent, /diag-ok/, "final answer must come from the post-tool reply");
      const secondRequest = JSON.stringify(seen.announcer[1] || []);
      assertMatch(secondRequest, /\[RUNNER\].*did not call any tool/, "the model must be told its announcement ran nothing");
    });
  });

  // T4.6: Two agents in one group thread run server turns at the same time instead of the second being refused.
  runner.register(4, "M6", "F12", "T4.6_session_runner_runs_teammates_concurrently_in_one_thread", async () => {
    await withFakeModel({
      slow: { delayMs: 1200, replies: [{ content: "Done: reviewed the module." }] }
    }, async (baseUrl) => {
      const threadId = `thread_e2e_squad_${Date.now()}`;
      const bots = ["bot_e2e_alpha", "bot_e2e_beta"];
      for (const b of bots) await configureFakeAgent(b, baseUrl, "slow");
      const starts = await Promise.all(bots.map(b =>
        requestJson("POST", "/api/sessions/turn", { threadId, botId: b, botName: b, prompt: "review", maxSteps: 3 })
      ));
      starts.forEach((r, i) => assertEqual(r.status, 200, `${bots[i]} start: ${r.raw}`));
      const turns = await waitForTurns(threadId, bots);
      assert(turns.every(t => t.status === "completed"), `both turns must complete: ${JSON.stringify(turns.map(t => [t.botId, t.status]))}`);
    });
  });
}

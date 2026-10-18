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

    // An agent's worktree is a branch of the room's project (the fixture repo), not of Vanaras.
    const wtRes = await requestJson("POST", "/api/agent/worktree", { botId: "bot_r1", botName: "R1", action: "ensure" });
    assertEqual(wtRes.status, 200, `worktree: ${wtRes.raw}`);
    assertEqual(wtRes.body.projectRoot, process.env.VANARAS_TEST_PROJECT, "the worktree must belong to the room's project");
    assertEqual(wtRes.body.branch, "vanara/r1");
    assert(fs.existsSync(path.join(wtRes.body.worktreePath, ".git")), "the worktree must be a git checkout");
    assert(fs.existsSync(path.join(wtRes.body.worktreePath, "src", "math.mjs")), "the worktree must contain the project's files");
    assert(!fs.existsSync(path.join(wtRes.body.worktreePath, "ui", "server.mjs")), "the worktree must not contain Vanaras's code");
  });

  // T4.3: Real-World Fast Codebase Symbol Navigation Grounding
  runner.register(4, "M2", "F2", "T4.3_fast_codebase_symbol_navigation", async () => {
    const symbolToFind = "multiply";

    const res = await requestJson("POST", "/api/agent/tool", {
      action: "grep_search",
      botId: "bot_r1",
      content: symbolToFind
    });

    assertEqual(res.status, 200, `grep_search failed: ${JSON.stringify(res.body)}`);
    assert(Array.isArray(res.body?.matches), "Matches must be an array");

    // Locate the definition in the project's src/math.mjs
    const serverMatch = res.body.matches.find(m => m.file?.includes("math.mjs"));
    assert(serverMatch, "Must find symbol occurrence in src/math.mjs");

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
        const step = typeof script.reply === "function"
          ? script.reply(payload)
          : script.replies[Math.min(seen[payload.model].length - 1, script.replies.length - 1)];
        if (script.delayMs) await new Promise(r => setTimeout(r, script.delayMs));
        res.writeHead(200, { "Content-Type": "application/json" });
        // step.raw sends a body as-is (e.g. OpenRouter's HTTP 200 + {"error": ...} for an overloaded provider).
        res.end(step.raw !== undefined ? step.raw : JSON.stringify({ choices: [{ message: { role: "assistant", content: step.content || "", tool_calls: step.tool_calls } }] }));
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
      const turnId = `turn_srv_e2e_${Date.now()}`;
      const start = await requestJson("POST", "/api/sessions/turn", { threadId, botId, botName: "Announcer", prompt: "run diagnostics", maxSteps: 6, turnId });
      assertEqual(start.status, 200, `turn start: ${start.raw}`);
      const [turn] = await waitForTurns(threadId, [botId]);
      assertEqual(turn.status, "completed", "turn must complete after the nudge");
      // A window that missed the live events catches up from the status list alone.
      assertEqual(turn.turnId, turnId, "status list must identify the turn");
      assertMatch(String(turn.finalContent || ""), /diag-ok/, "status list must carry the finished turn's result");
      const step = (turn.toolCalls || []).find(c => c.name === "shell_exec");
      assert(step && step.target === "echo diag-ok" && /diag-ok/.test(step.output), `status list must show each step run: ${JSON.stringify(turn.toolCalls)}`);
      const st = await requestJson("GET", `/api/sessions/status?threadId=${encodeURIComponent(threadId)}`);
      const calls = st.body.turn.toolCalls || [];
      assert(calls.some(c => c.name === "shell_exec" && /diag-ok/.test(c.output)), `shell_exec must have run: ${JSON.stringify(calls)}`);
      assertMatch(st.body.turn.finalContent, /diag-ok/, "final answer must come from the post-tool reply");
      const secondRequest = JSON.stringify(seen.announcer[1] || []);
      assertMatch(secondRequest, /\[RUNNER\].*did not call any tool/, "the model must be told its announcement ran nothing");
      const afterTool = seen.announcer[2] || [];
      const last = afterTool[afterTool.length - 1] || {};
      assert(last.role === "user" && /Task reminder[\s\S]*run diagnostics/.test(last.content), `after tool output the request must be restated last: ${JSON.stringify(last).slice(0, 300)}`);
      assertEqual(afterTool.filter(m => /Task reminder/.test(String(m.content || ""))).length, 1, "only the latest reminder is kept");
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

  // T4.7: An A/B panel runs every persona through every round on the server, tallies votes exactly, and has
  // the moderator summarise; persona generation turns a brief into panelists.
  runner.register(4, "M6", "F12", "T4.7_panel_ab_vote_runs_rounds_tallies_and_summarises", async () => {
    // Each persona votes by name, so the expected tally is known regardless of answer order.
    const votes = { "Maya R.": "A", "Dev P.": "B", "Ana L.": "B" };
    await withFakeModel({
      panelfake: {
        reply: (payload) => {
          const sys = String(payload.messages?.[0]?.content || "");
          const user = String(payload.messages?.[1]?.content || "");
          if (/research panels/.test(sys)) {
            return { content: 'Here:\n[{"name":"Maya R.","persona":"28, commuter"},{"name":"Dev P.","persona":"41, audio engineer"},{"name":"Ana L.","persona":"19, student"}]' };
          }
          if (/moderator/.test(sys)) return { content: `MODERATOR SUMMARY. Saw tally: ${/\| B — Upbeat \| 2 \| 67% \|/.test(user) ? "yes" : "no"}` };
          const who = /^You are ([^.]+\.)/.exec(sys)?.[1] || "?";
          const round = /round 2 of 2/.test(user) ? 2 : 1;
          return { content: `${who} round ${round}. ${round === 2 && /other panelists said/.test(user) ? "Saw others." : ""}\nVOTE: ${votes[who] || "C"}` };
        }
      }
    }, async (baseUrl) => {
      const modelBotId = "bot_e2e_panel_model";
      await configureFakeAgent(modelBotId, baseUrl, "panelfake");

      const gen = await requestJson("POST", "/api/panels/personas", { brief: "podcast listeners", count: 3, modelBotId }, {}, 15000);
      assertEqual(gen.status, 200, `persona generation: ${gen.raw}`);
      const panelists = gen.body.personas.map((p, i) => ({ id: `p${i}`, ...p }));
      assertEqual(panelists.map(p => p.name).join(","), "Maya R.,Dev P.,Ana L.", "personas come from the model's JSON");

      const threadId = `thread_e2e_panel_${Date.now()}`;
      const start = await requestJson("POST", "/api/panels/run", {
        threadId, topic: "Which intro?", mode: "vote", rounds: 2, concurrency: 2, modelBotId, panelists,
        options: [{ label: "Calm", text: "Soft piano intro" }, { label: "Upbeat", text: "Drum hit intro" }],
        materials: [{ type: "text", label: "Brief", text: "Episode about sleep" }]
      });
      assertEqual(start.status, 200, `panel start: ${start.raw}`);

      let run = null;
      for (let i = 0; i < 80 && !(run && ["completed", "error", "stopped"].includes(run.status)); i++) {
        await new Promise(r => setTimeout(r, 250));
        const st = await requestJson("GET", `/api/panels/status?runId=${encodeURIComponent(start.body.runId)}`);
        run = st.body.runs?.[0] || null;
      }
      assertEqual(run?.status, "completed", `panel must complete: ${JSON.stringify(run && { status: run.status, error: run.error })}`);
      assertEqual(run.messages.length, 3 * 2 + 1, "one answer per panelist per round, plus the summary");
      assert(run.messages.filter(m => m.round === 2).every(m => /Saw others\./.test(m.text)), "round 2 must show each panelist the others' answers");
      assertEqual(JSON.stringify(run.tally.counts), "[1,2]", "tally must be exact");
      const summary = run.messages.find(m => m.isPanelSummary);
      assert(summary && /\| B — Upbeat \| 2 \| 67% \|/.test(summary.text), `summary must carry the computed tally: ${summary?.text}`);
      assertMatch(summary.text, /MODERATOR SUMMARY\. Saw tally: yes/, "moderator must be given the computed tally");
    });
  });

  // T4.8: A provider that answers HTTP 200 with an {"error"} body (OpenRouter overload) is retried, and a panelist
  // whose calls keep failing is reported as not answering instead of being shown, tallied or summarised as "".
  runner.register(4, "M6", "F12", "T4.8_panel_retries_overloaded_provider_and_reports_failures", async () => {
    const calls = {};
    const overloaded = '\n   \n{"id":"gen-1","error":{"message":"Upstream error from Nvidia: Service temporarily overloaded","code":503}}';
    await withFakeModel({
      flaky: {
        reply: (payload) => {
          const sys = String(payload.messages?.[0]?.content || "");
          if (/moderator/.test(sys)) return { content: "SUMMARY OK" };
          const who = /^You are ([^.]+\.)/.exec(sys)?.[1] || "?";
          calls[who] = (calls[who] || 0) + 1;
          if (who === "Gone Z.") return { raw: overloaded };
          return calls[who] === 1 ? { raw: overloaded } : { content: `${who} has a view.\nPOSITION: yes` };
        }
      }
    }, async (baseUrl) => {
      const modelBotId = "bot_e2e_flaky_model";
      await configureFakeAgent(modelBotId, baseUrl, "flaky");
      const threadId = `thread_e2e_flaky_${Date.now()}`;
      const start = await requestJson("POST", "/api/panels/run", {
        threadId, topic: "Ship it?", mode: "debate", rounds: 1, concurrency: 3, modelBotId,
        panelists: [{ id: "a", name: "Kept A.", persona: "engineer" }, { id: "g", name: "Gone Z.", persona: "designer" }]
      });
      assertEqual(start.status, 200, `panel start: ${start.raw}`);
      let run = null;
      for (let i = 0; i < 240 && !(run && ["completed", "error", "stopped"].includes(run.status)); i++) {
        await new Promise(r => setTimeout(r, 250));
        run = (await requestJson("GET", `/api/panels/status?runId=${encodeURIComponent(start.body.runId)}`)).body.runs?.[0] || null;
      }
      assertEqual(run?.status, "completed", `panel must complete: ${JSON.stringify(run && { status: run.status, error: run.error })}`);
      const kept = run.messages.find(m => m.panelist.name === "Kept A.");
      assertMatch(kept.text, /has a view/, "a transient overload must be retried until the answer arrives");
      const gone = run.messages.find(m => m.panelist.name === "Gone Z.");
      assert(gone.failed && /overloaded/.test(gone.text), `a persistent overload must show its reason: ${gone.text}`);
      const summary = run.messages.find(m => m.isPanelSummary);
      assertMatch(summary.text, /1 did not answer \(model errors\)[\s\S]*SUMMARY OK/, "the result must report who did not answer");
    });
  });

  // T4.9: code_search finds code an agent just wrote (the index refreshes on edit) and returns passages with
  // line numbers, ranked, scoped to the agent's worktree. Works with or without the embedding model.
  runner.register(4, "M2", "F3", "T4.9_code_search_finds_fresh_code_with_lines", async () => {
    const file = `cs_probe_${Date.now()}.mjs`;
    const body = [
      "// Converts a temperature reading so the dashboard can show it.",
      "export function celsiusToFahrenheitForDashboard(c) {",
      "  return c * 9 / 5 + 32;",
      "}",
      "",
      "export function unrelatedHelper() {",
      "  return 'nothing to see';",
      "}"
    ].join("\n");
    await requestJson("POST", "/api/agent/tool", { action: "fs_write", botId: "bot_r1", filePath: file, content: body });
    try {
      const r = await requestJson("POST", "/api/agent/tool", { action: "code_search", botId: "bot_r1", args: { query: "convert celsius temperature to fahrenheit" } }, {}, 60000);
      assertEqual(r.status, 200, `code_search: ${r.raw}`);
      assert(r.body.ok, `code_search failed: ${r.raw}`);
      const top = r.body.results[0];
      assert(top && top.path.endsWith(file) && top.symbol === "celsiusToFahrenheitForDashboard", `top result must be the new function: ${JSON.stringify(r.body.results.slice(0, 3))}`);
      assertMatch(r.body.output, new RegExp(`${file.replace(".", "\\.")}:1-\\d+ \\(celsiusToFahrenheitForDashboard\\)`), "output must carry path, lines and symbol");
      assertMatch(r.body.output, /\s2 {2}export function celsiusToFahrenheitForDashboard/, "passages must be line-numbered");
      const scoped = await requestJson("POST", "/api/agent/tool", { action: "code_search", botId: "bot_r1", args: { query: "x", path: "../../.." } });
      assertEqual(scoped.status, 400, "a scope outside the worktree must be refused");
    } finally {
      await requestJson("POST", "/api/agent/tool", { action: "shell_exec", botId: "bot_r1", command: `rm -f agent_workspace/r1/${file} ${file}` });
    }
  });

  // T4.10: an agent configured with codeSearchMode "keyword" gets BM25-only results (no embedding model used).
  runner.register(4, "M2", "F3", "T4.10_code_search_keyword_mode_is_bm25_only", async () => {
    const botId = "bot_e2e_bm25";
    await requestJson("POST", "/api/agent/skill", { botId, botName: "bm25", action: "set", skillMarkdown: "", agentConfig: { codeSearchMode: "keyword" } });
    const r = await requestJson("POST", "/api/agent/tool", { action: "code_search", botId, args: { query: "multiply numbers" } }, {}, 60000);
    assertEqual(r.status, 200, `code_search: ${r.raw}`);
    assertMatch(r.body.output, /keyword \(BM25\)/, "output must say the search was keyword-only");
    assert(r.body.semantic && r.body.semantic.enabled === false, "semantic search must be off");
    assert(r.body.results.length > 0 && r.body.results.every(x => x.via.join() === "keyword"), `results must come from the keyword index only: ${JSON.stringify(r.body.results.slice(0, 2))}`);
  });

  // T4.11: POST /api/code-search searches the room's project (and refuses a root outside it).
  runner.register(4, "M2", "F3", "T4.11_code_search_route_searches_the_project", async () => {
    const r = await requestJson("POST", "/api/code-search", { query: "multiply two numbers", limit: 3, semantic: false }, {}, 60000);
    assertEqual(r.status, 200, `code-search: ${r.raw}`);
    assertEqual(r.body.root, process.env.VANARAS_TEST_PROJECT, "the search root is the room's project");
    assert(r.body.results.some(x => x.path === "src/math.mjs" && x.symbol === "multiply"), `must find multiply in src/math.mjs: ${JSON.stringify(r.body.results)}`);
    const outside = await requestJson("POST", "/api/code-search", { query: "x", root: "/etc" });
    assertEqual(outside.status, 400, `a root outside the project must be refused: ${outside.raw}`);
  });
}

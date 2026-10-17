// Tier 5: platform security regressions. Registered only when VANARAS_TEST_ISOLATED=1 (see e2e-suite.mjs).
import fs from "node:fs";
import path from "node:path";
import { VANARAS_ROOT, requestJson, assert, assertEqual, assertIncludes } from "./test-harness.mjs";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tool = (body, timeout = 8000) => requestJson("POST", "/api/agent/tool", body, {}, timeout);

async function waitForApproval(commandPart, timeoutMs = 6000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const list = await requestJson("GET", "/api/approvals/list");
    const hit = (list.body?.approvals || []).find(a => a.command.includes(commandPart));
    if (hit) return hit;
    await sleep(100);
  }
  throw new Error(`no approval request appeared for "${commandPart}"`);
}

export function registerTier5Tests(runner) {
  runner.register(5, "M8", "F15", "T5.1_private_state_is_not_served_as_static", async () => {
    for (const p of ["/.vanaras-keys.json", "/.vanaras-workspace.json", "/.vanaras-agents/bot_r1/memory.json", "/server.mjs", "/src/security.mjs"]) {
      const res = await requestJson("GET", p);
      assertEqual(res.status, 404, `${p} must not be served`);
    }
    assertEqual((await requestJson("GET", "/..%2f..%2fetc%2fpasswd")).status, 400, "encoded traversal is refused");
    const shell = await requestJson("GET", "/");
    assertEqual(shell.status, 200, "the app shell is still served");
    assertIncludes(String(shell.raw).toLowerCase(), "<html", "app shell is html");
  });

  runner.register(5, "M8", "F15", "T5.2_malformed_url_does_not_crash_the_server", async () => {
    const res = await requestJson("GET", "/%E0%A4%A");
    assertEqual(res.status, 400, "malformed escape is a client error");
    const health = await requestJson("GET", "/api/health");
    assertEqual(health.body?.ok, true, "server must still be alive");
  });

  runner.register(5, "M10", "F16", "T5.3_model_cannot_self_approve_commands", async () => {
    const marker = `vx_citest_noapprove_${process.pid}_${Date.now()}`;
    const cmd = `mkdir -p ${marker} && rm -rf ${marker} && echo done_${marker}`;
    // approved:true at every level a model-controlled argument could reach.
    const pending = tool({ tool: "shell_exec", botId: "bot_r1", command: cmd, approved: true, permissionPolicy: "auto", args: { approved: true } }, 15000);
    const approval = await waitForApproval(marker);
    assertEqual(approval.status, "pending", "the command must wait for a human decision");
    await requestJson("POST", "/api/approvals/respond", { approvalId: approval.approvalId, decision: "deny" });
    const res = await pending;
    assertEqual(res.body?.ok, false);
    assertIncludes(res.body?.error || "", "denied by user");
  });

  runner.register(5, "M10", "F16", "T5.4_every_command_launcher_is_gated", async () => {
    const marker = `vx_citest_gate_${process.pid}_${Date.now()}`;
    const rmCmd = `rm -rf ${marker}`;
    for (const body of [
      { tool: "start_process", botId: "bot_r1", command: rmCmd },
      { tool: "verify_project", botId: "bot_r1", command: rmCmd }
    ]) {
      const pending = tool(body, 15000);
      const approval = await waitForApproval(marker);
      await requestJson("POST", "/api/approvals/respond", { approvalId: approval.approvalId, decision: "deny" });
      const res = await pending;
      assertEqual(res.body?.ok, false, `${body.tool} must honour the approval gate`);
      assertIncludes(res.body?.error || "", "denied by user");
    }
    // A model-supplied MCP launch command is gated too.
    const fixture = path.join(VANARAS_ROOT, "tests", "fixtures", "mcp-test-server.mjs");
    const pending = tool({ tool: "mcp_probe", botId: "bot_r1", mcpCommand: `node "${fixture}"` }, 15000);
    const approval = await waitForApproval("mcp-test-server.mjs");
    await requestJson("POST", "/api/approvals/respond", { approvalId: approval.approvalId, decision: "deny" });
    const res = await pending;
    assertEqual(res.body?.ok, false, "model-supplied MCP command must need approval");
    assertIncludes(res.body?.error || "", "denied by user");
  });

  runner.register(5, "M10", "F16", "T5.5_destructive_commands_are_denied_even_when_quoted", async () => {
    for (const command of ["rm -rf /", 'rm -rf "/"', "dd if=/dev/zero of=/dev/sda", ":(){ :|:& };:"]) {
      const res = await tool({ tool: "shell_exec", botId: "bot_r1", command });
      assertEqual(res.body?.ok, false, command);
      assertIncludes(res.body?.error || "", "Permission Denied", command);
    }
  });

  runner.register(5, "M10", "F17", "T5.6_restricted_subagents_are_allowlisted_without_side_effects", async () => {
    const id = `sub_explore_citest_${process.pid}_${Date.now()}`;
    for (const t of ["fs_write", "shell_exec", "verify_project", "mcp_call", "start_process", "spawn_subagent"]) {
      const res = await tool({ tool: t, botId: id, command: "echo x", filePath: "x.txt", content: "x" });
      assertEqual(res.body?.ok, false, `${t} must be denied to an explore subagent`);
      assertIncludes(res.body?.error || "", "Access Denied", t);
    }
    assert(!fs.existsSync(path.join(VANARAS_ROOT, ".worktrees", id)), "a denied call must not create a worktree");
    const plan = await tool({ tool: "git_diff", botId: id.replace("explore", "plan") });
    assertEqual(plan.body?.ok, false, "plan subagents are narrower than explore");
  });
}

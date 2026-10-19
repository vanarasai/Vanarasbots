// The agent tool executor: file, edit, shell, search, process, verify, subagent and MCP tools.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadAgentConfig } from "./agent-store.mjs";
import { buildAgentExecEnv, resolveSharedVenvDir } from "./env.mjs";
import { broadcastEvent } from "./events.mjs";
import { codeSearch } from "./code-index.mjs";
import { callStdioMcpServer } from "./mcp-client.mjs";
import { killProcessTree, spawnCommandAsync, spawnShellProcessGroup } from "./process.mjs";
import { checkCommandPermission, checkToolAllowed } from "./security.mjs";
import { activeApprovals, activeSubagents, agentBackgroundProcesses } from "./state.mjs";
import { spawnSubagentAsync } from "./subagents.mjs";
import { execFileAsync, isPathInside, safeGitCommitAsync } from "./util.mjs";
import { ensureAgentWorktree, listAgentCodeFiles } from "./worktree.mjs";

// Every file tool resolves its path here: relative to the agent's checkout of the project, and only inside
// it, also after following symlinks. There are no fallbacks to other folders, so a tool cannot read or
// change files outside the room's project. (Shell commands start in the worktree but are not sandboxed.)
export function resolveInWorktree(wt, raw) {
  const input = String(raw ?? "").trim().replace(/^file:\/\//i, "") || ".";
  const root = wt.worktreePath;
  const abs = path.resolve(root, input);
  if (!isPathInside(abs, root)) return { error: `Path outside this agent's worktree blocked: ${input}` };
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== root && probe !== path.dirname(probe)) probe = path.dirname(probe);
  try {
    if (!isPathInside(fs.realpathSync(probe), fs.realpathSync(root))) {
      return { error: `Path leaves this agent's worktree through a symlink: ${input}` };
    }
  } catch {}
  return { abs, rel: path.relative(root, abs) || "." };
}

// Every tool that launches a process funnels through here, so the DENY/ASK policy cannot be skipped by
// choosing a different tool. Nothing the model supplies can pre-approve a command: approval only ever
// comes from the user, via POST /api/approvals/respond.
//   returns null  -> proceed
//   returns {...} -> a ready-to-return tool response (denied / timed out)
async function gateCommand({ commandText, label = "Command", forceAsk = false, forceAskReason = "", botId, botName, threadId, permissionPolicy }) {
  const perm = checkCommandPermission(commandText, { permissionPolicy });
  if (perm.policy === "deny") {
    return { status: 200, data: { ok: false, error: `Permission Denied: ${perm.reason}` } };
  }
  const reason = perm.policy === "ask" ? perm.reason : (forceAsk ? forceAskReason : "");
  if (!reason) return null;

  const approvalId = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let timer;
  const decision = await new Promise((resolve) => {
    activeApprovals.set(approvalId, {
      approvalId,
      threadId: threadId || "",
      botId: botId || "bot_r1",
      botName: botName || "R1",
      command: commandText,
      reason,
      status: "pending",
      createdAt: Date.now(),
      resolve
    });
    broadcastEvent("approval_requested", {
      approvalId,
      threadId: threadId || "",
      botId: botId || "bot_r1",
      botName: botName || "R1",
      command: commandText,
      reason
    });
    // Wait up to 60s for the user's response.
    timer = setTimeout(() => resolve({ decision: "timeout" }), 60000);
  });
  clearTimeout(timer);
  activeApprovals.delete(approvalId);

  if (decision.decision !== "allow") {
    return {
      status: 200,
      data: {
        ok: false,
        error: `${label} '${commandText}' was ${decision.decision === "timeout" ? "timed out waiting for approval" : "denied by user"}.`
      }
    };
  }
  return null;
}

  // 2D. Per-Agent Tool & MCP Server Executor (Core Tool Execution Function)
export async function executeAgentToolInternal(params = {}) {
  const {
    botId = "bot_r1",
    botName = "R1",
    tool,
    action,
    args = {},
    toolName: requestedMcpToolName,
    toolArgs: requestedMcpToolArgs,
    filePath,
    content,
    mcpCommand,
    streamId = "",
    threadId = "",
    pattern,
    query,
    isRegex,
    path: pathParam,
    dir,
    directory,
    oldString,
    newString,
    old_str,
    new_str,
    targetContent,
    replacementContent,
    command,
    processId,
    name,
    lines,
    timeout,
    maxOutput,
    projectPath = ""
  } = params;
  const toolName = tool || action;

  // Subagent capability allowlist: enforced first, so a denied call has no side effects at all.
  const toolCheck = checkToolAllowed(botId, toolName);
  if (!toolCheck.allowed) {
    return { status: 200, data: { ok: false, error: toolCheck.reason } };
  }

  const wt = ensureAgentWorktree(botId || "bot_r1", botName || "R1", projectPath);
  const savedAgentCfg = loadAgentConfig(botId || "bot_r1") || {};
  // The approval policy comes only from the saved agent configuration, never from tool arguments.
  const permissionPolicy = savedAgentCfg.permissionPolicy || "auto";
  const gateCtx = { botId, botName, threadId, permissionPolicy };
  const savedMcpCommand = String(savedAgentCfg.mcpCommand || "").trim();
  const suppliedMcpCommand = String(args.mcpCommand || mcpCommand || "").trim();
  const effectiveMcpCmd = suppliedMcpCommand || savedMcpCommand;
  // A server command configured in Agent Studio is trusted; one supplied with the call launches an
  // arbitrary executable, so it needs the same approval as any other risky command.
  const mcpGate = () => gateCommand({
    ...gateCtx,
    commandText: effectiveMcpCmd,
    label: "MCP server",
    forceAsk: Boolean(suppliedMcpCommand) && suppliedMcpCommand !== savedMcpCommand,
    forceAskReason: "A tool call asked to launch an MCP server command that is not configured for this agent."
  });

  // 1. MCP PROBE
  if (toolName === "mcp_probe") {
    if (!effectiveMcpCmd) {
      return { status: 400, data: { ok: false, error: "Missing MCP command: provide mcpCommand in tool args or configure the agent's MCP Server in Agent Studio" } };
    }
    const denied = await mcpGate();
    if (denied) return denied;
    const mcpRes = await callStdioMcpServer({ commandLine: effectiveMcpCmd, cwd: wt.worktreePath, method: "tools/list" });
    const tools = mcpRes.result?.tools || [];
    return { status: 200, data: { ...mcpRes, tools } };
  }

  // 2. MCP CALL
  if (toolName === "mcp_call") {
    if (!effectiveMcpCmd) {
      return { status: 400, data: { ok: false, error: "Missing MCP command: provide mcpCommand in tool args or configure the agent's MCP Server in Agent Studio" } };
    }
    const denied = await mcpGate();
    if (denied) return denied;
    const targetMcpTool = requestedMcpToolName || args.name || args.toolName || "";
    const targetMcpArgs = requestedMcpToolArgs || args.arguments || args.args || {};
    const mcpRes = await callStdioMcpServer({
      commandLine: effectiveMcpCmd,
      cwd: wt.worktreePath,
      method: "tools/call",
      params: { name: targetMcpTool, arguments: targetMcpArgs }
    });
    const contentItems = Array.isArray(mcpRes.result?.content)
      ? mcpRes.result.content.map(c => c.text || JSON.stringify(c)).join("\n")
      : "";
    const output = contentItems || (mcpRes.result ? JSON.stringify(mcpRes.result, null, 2) : "");
    return { status: 200, data: { ...mcpRes, output } };
  }

  // 3. FS READ
  if (toolName === "fs_read") {
    const rawInput = String(filePath || pathParam || args.filePath || args.path || ".").trim();
    const resolved = resolveInWorktree(wt, rawInput);
    if (resolved.error) return { status: 200, data: { ok: false, error: resolved.error } };
    const existingTarget = resolved.abs;
    if (!fs.existsSync(existingTarget)) {
      return { status: 200, data: { ok: false, error: `File not found in ${wt.branch}: ${rawInput}` } };
    }

    const stat = fs.statSync(existingTarget);
    if (stat.isDirectory()) {
      const codeFiles = listAgentCodeFiles(wt.codeDir).map(f => f.name);
      const dirEntries = fs.readdirSync(existingTarget, { withFileTypes: true })
        .filter(e => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "target")
        .slice(0, 50)
        .map(e => (e.isDirectory() ? `${e.name}/` : e.name));
      const listing = [
        `Directory: ${existingTarget} (branch ${wt.branch})`,
        codeFiles.length > 0 ? `Files: ${codeFiles.join(", ")}` : "",
        `Entries: ${dirEntries.join(", ") || "(empty)"}`
      ].filter(Boolean).join("\n");
      return {
        status: 200,
        data: {
          ok: true,
          isDirectory: true,
          worktreePath: wt.worktreePath,
          codeDir: wt.codeDir,
          branch: wt.branch,
          output: listing
        }
      };
    }

    const text = fs.readFileSync(existingTarget, "utf8").slice(0, 25000);
    return { status: 200, data: { ok: true, worktreePath: wt.worktreePath, codeDir: wt.codeDir, branch: wt.branch, output: text } };
  }

  // 4. FS WRITE
  if (toolName === "fs_write") {
    const rawInput = String(filePath || pathParam || args.filePath || args.path || "notes.md").trim();
    const resolved = resolveInWorktree(wt, rawInput);
    if (resolved.error) return { status: 400, data: { ok: false, error: resolved.error } };
    const bodyContent = String(content ?? args.content ?? "");
    fs.mkdirSync(path.dirname(resolved.abs), { recursive: true });
    fs.writeFileSync(resolved.abs, bodyContent, "utf8");
    return {
      status: 200,
      data: {
        ok: true,
        bytesWritten: bodyContent.length,
        worktreePath: wt.worktreePath,
        codeDir: wt.codeDir,
        branch: wt.branch,
        output: `Wrote ${bodyContent.length} bytes to ${resolved.rel} on ${wt.branch}`
      }
    };
  }

  // 5. EXACT EDIT (P2)
  if (toolName === "exact_edit") {
    const rawInput = String(filePath || pathParam || args.filePath || args.path || args.file || "").trim();
    if (!rawInput) {
      return { status: 400, data: { ok: false, error: "Missing filePath for exact_edit" } };
    }
    const resolved = resolveInWorktree(wt, rawInput);
    if (resolved.error) return { status: 400, data: { ok: false, error: resolved.error } };
    const target = resolved.abs;

    if (!fs.existsSync(target)) {
      return { status: 200, data: { ok: false, error: `File not found: ${rawInput}` } };
    }

    const originalContent = fs.readFileSync(target, "utf8");
    const targetOld = String(oldString ?? old_str ?? targetContent ?? args.oldString ?? args.old_str ?? args.targetContent ?? "");
    const targetNew = String(newString ?? new_str ?? replacementContent ?? args.newString ?? args.new_str ?? args.replacementContent ?? "");

    if (!targetOld) {
      return { status: 400, data: { ok: false, error: "Missing oldString to replace" } };
    }

    const matchesCount = originalContent.split(targetOld).length - 1;
    if (matchesCount === 0) {
      return { status: 200, data: { ok: false, error: `Target substring not found in ${rawInput}` } };
    }
    if (matchesCount > 1) {
      return { status: 200, data: { ok: false, error: `Target substring appears ${matchesCount} times in ${rawInput}; must match uniquely (1 time) to edit safely` } };
    }

    const updatedContent = originalContent.replace(targetOld, targetNew);
    fs.writeFileSync(target, updatedContent, "utf8");
    return {
      status: 200,
      data: {
        ok: true,
        tool: "exact_edit",
        file: resolved.rel,
        output: `Successfully edited ${resolved.rel} (1 exact replacement applied)`
      }
    };
  }

  // 6. GIT COMMIT
  if (toolName === "git_commit") {
    const slug = (botName || botId).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    const msg = String(content || filePath || args.message || `feat(${slug}): autonomous agent commit`);
    let out = "";
    try {
      await safeGitCommitAsync(wt.worktreePath, msg, 5000);
      const { stdout } = await execFileAsync("git", ["log", "--oneline", "-n", "3"], {
        cwd: wt.worktreePath,
        timeout: 5000
      });
      out = stdout.trim();
    } catch (err) {
      out = err.message;
    }
    return { status: 200, data: { ok: true, worktreePath: wt.worktreePath, branch: wt.branch, output: out } };
  }

  // 7. GIT STATUS & GIT DIFF
  if (toolName === "git_status" || toolName === "git_diff") {
    let out = "";
    try {
      if (toolName === "git_diff") {
        const { stdout } = await execFileAsync("git", ["diff", "HEAD"], { cwd: wt.worktreePath, timeout: 5000 });
        out = stdout.trim();
      } else {
        const st = await execFileAsync("git", ["status", "--short"], { cwd: wt.worktreePath, timeout: 5000 });
        const br = await execFileAsync("git", ["branch", "--show-current"], { cwd: wt.worktreePath, timeout: 5000 });
        const codeFiles = listAgentCodeFiles(wt.codeDir).map(f => f.name);
        out = [
          `Branch: ${br.stdout.trim() || wt.branch} (${wt.codeDir})`,
          codeFiles.length > 0 ? `Workspace files: ${codeFiles.join(", ")}` : "",
          st.stdout.trim() || "(Clean worktree)"
        ].filter(Boolean).join("\n");
      }
    } catch (err) {
      out = err.message;
    }
    return { status: 200, data: { ok: true, worktreePath: wt.worktreePath, codeDir: wt.codeDir, branch: wt.branch, output: out || "(Clean worktree)" } };
  }

  // 8. SHELL EXEC (P2: configurable timeout up to 300s, maxOutput up to 50k)
  if (toolName === "shell_exec" || toolName === "shell") {
    const rawCmd = String(content || filePath || command || args.command || "").trim();
    const execCwd = wt.worktreePath;
    const sharedVenv = resolveSharedVenvDir(execCwd, wt.worktreePath);
    let cmdStr = rawCmd
      .replace(/\\\\\(/g, "\\(")
      .replace(/\\\\\)/g, "\\)");
    if (sharedVenv) {
      cmdStr = cmdStr.replace(/\/(?:opt\/homebrew|usr\/local)\/bin\/(python3|python|pip3|pip)\b/g, "$1");
    }
    cmdStr = cmdStr.replace(
      /\blsof\s+(?:-ti|-t\s+-i)\s*:?\s*(?:tcp:)?(\d{2,5})\b(?![^|;&\n]*-sTCP)/gi,
      "lsof -nP -tiTCP:$1 -sTCP:LISTEN"
    );
    if (!cmdStr) {
      return { status: 400, data: { ok: false, error: "Missing shell command" } };
    }

    // Permission check (Allow / Ask / Deny): shared with every other command-launching tool.
    const gated = await gateCommand({ ...gateCtx, commandText: cmdStr });
    if (gated) return gated;
    const effectiveTimeout = Math.min(300000, Math.max(5000, Number(timeout || args.timeout || 120000)));
    const effectiveMaxOutput = Math.min(50000, Math.max(1000, Number(maxOutput || args.maxOutput || 25000)));

    const execRes = await spawnCommandAsync(cmdStr, {
      cwd: execCwd,
      worktreePath: wt.worktreePath,
      timeout: effectiveTimeout,
      trackKey: botId || "bot_r1",
      onProgress: (chunk, tailOutput) => {
        if (streamId) {
          broadcastEvent("tool_stream", {
            streamId,
            threadId,
            botId: botId || "bot_r1",
            botName: botName || "R1",
            command: cmdStr,
            cwd: execCwd,
            branch: wt.branch,
            chunk,
            output: tailOutput
          });
        }
      }
    });
    return {
      status: 200,
      data: {
        ok: execRes.exitCode === 0,
        exitCode: execRes.exitCode,
        cwd: execCwd,
        branch: wt.branch,
        output: (execRes.output || `(exit ${execRes.exitCode})`).slice(-effectiveMaxOutput)
      }
    };
  }

  // 9. GREP SEARCH
  if (toolName === "code_search") {
    const q = String(query ?? args.query ?? pattern ?? args.pattern ?? content ?? args.content ?? "").trim();
    if (!q) return { status: 400, data: { ok: false, error: "code_search needs a query" } };
    const scope = String(pathParam || dir || directory || args.path || args.dir || "").trim();
    if (scope) {
      const resolved = resolveInWorktree(wt, scope);
      if (resolved.error) return { status: 400, data: { ok: false, error: resolved.error } };
    }
    try {
      // Per-agent: "hybrid" (default) or "keyword" (BM25 only, like XERJ; needs no embedding model).
      const keywordOnly = String(savedAgentCfg.codeSearchMode || "").toLowerCase() === "keyword";
      const r = await codeSearch(wt.worktreePath, q, { limit: Number(args.limit) || 8, pathPrefix: scope, semantic: !keywordOnly });
      const mode = r.semantic.enabled
        ? `hybrid (keyword + ${r.semantic.model}, ${Math.round(r.semantic.coverage * 100)}% embedded)`
        : keywordOnly
          ? "keyword (BM25)"
          : `keyword only${r.semantic.reason ? ` — semantic search off: ${r.semantic.reason}` : ""}`;
      const output = r.results.length
        ? `${r.results.length} passages for "${q}" · ${mode} · ${r.files} files indexed\n\n${r.text}`
        : `No passages matched "${q}" (${mode}, ${r.files} files indexed). Try other words, or grep_search for an exact string.`;
      return { status: 200, data: { ok: true, output, results: r.results.map(({ text, ...rest }) => rest), semantic: r.semantic } };
    } catch (err) {
      return { status: 500, data: { ok: false, error: `code_search failed: ${err.message}` } };
    }
  }

  if (toolName === "grep_search") {
    const rawPattern = pattern !== undefined ? pattern : (content !== undefined ? content : (args.pattern ?? args.query ?? args.content));
    if (rawPattern === undefined || rawPattern === null || String(rawPattern).length === 0) {
      return { status: 400, data: { ok: false, error: "Search pattern cannot be empty" } };
    }
    const patternStr = String(rawPattern);
    const isRegexFlag = Boolean(isRegex || args.isRegex);
    let regexObj = null;
    if (isRegexFlag) {
      try {
        regexObj = new RegExp(patternStr);
      } catch (regErr) {
        return { status: 400, data: { ok: false, error: `Invalid regular expression: ${regErr.message}` } };
      }
    }

    const rawSearchPath = String(pathParam || dir || directory || args.path || args.dir || filePath || "").trim();
    let targetSearchDir = wt.worktreePath;
    if (rawSearchPath) {
      const resolved = resolveInWorktree(wt, rawSearchPath);
      if (resolved.error) return { status: 400, data: { ok: false, error: resolved.error } };
      if (fs.existsSync(resolved.abs)) targetSearchDir = resolved.abs;
    }

    const matches = [];
    let usedGitGrep = false;
    try {
      const gitGrepArgs = ["grep", "-n", "-I", "--untracked"];
      if (isRegexFlag) gitGrepArgs.push("-E");
      else gitGrepArgs.push("-F");
      gitGrepArgs.push(patternStr);

      const gitGrepOut = execFileSync("git", gitGrepArgs, {
        cwd: targetSearchDir,
        stdio: "pipe",
        timeout: 8000
      }).toString("utf8");

      const lines = gitGrepOut.split(/\r?\n/).filter(Boolean);
      for (const l of lines) {
        const firstColon = l.indexOf(":");
        if (firstColon === -1) continue;
        const secondColon = l.indexOf(":", firstColon + 1);
        if (secondColon === -1) continue;
        const matchFile = l.slice(0, firstColon);
        const lineNum = parseInt(l.slice(firstColon + 1, secondColon), 10);
        const lineText = l.slice(secondColon + 1);
        matches.push({ file: matchFile, line: lineNum, text: lineText });
      }
      usedGitGrep = true;
    } catch (gitErr) {
      if (gitErr.status === 1) {
        usedGitGrep = true;
      }
    }

    if (!usedGitGrep) {
      const ignoreNames = new Set(["node_modules", ".git", ".venv", "target", "dist", ".cache"]);
      function walkDir(d, relPrefix = "") {
        if (matches.length >= 250) return;
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          if (ignoreNames.has(ent.name) || ent.name.startsWith(".")) continue;
          const fullP = path.join(d, ent.name);
          const relP = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
          if (ent.isDirectory()) {
            walkDir(fullP, relP);
          } else if (ent.isFile()) {
            try {
              const stat = fs.statSync(fullP);
              if (stat.size > 1000000) continue;
              const fileStr = fs.readFileSync(fullP, "utf8");
              const fileLines = fileStr.split(/\r?\n/);
              for (let i = 0; i < fileLines.length; i++) {
                const lineContent = fileLines[i];
                let hit = false;
                if (isRegexFlag && regexObj) {
                  hit = regexObj.test(lineContent);
                } else {
                  hit = lineContent.includes(patternStr);
                }
                if (hit) {
                  matches.push({ file: relP, line: i + 1, text: lineContent });
                  if (matches.length >= 250) break;
                }
              }
            } catch {}
          }
        }
      }
      walkDir(targetSearchDir);
    }

    const outputLines = matches.slice(0, 100).map(m => `${m.file}:${m.line}: ${m.text}`);
    const formattedOut = outputLines.length > 0 ? outputLines.join("\n") : "(no matches found)";

    return {
      status: 200,
      data: {
        ok: true,
        tool: "grep_search",
        searchRoot: targetSearchDir,
        matches,
        output: formattedOut
      }
    };
  }

  // 10. FIND FILES
  if (toolName === "find_files") {
    const fileQuery = content !== undefined
      ? String(content)
      : String(query ?? args.query ?? args.content ?? args.pattern ?? "");
    if (fileQuery.includes("..")) {
      return { status: 400, data: { ok: false, error: "Path traversal outside workspace blocked" } };
    }

    let allFiles = [];
    try {
      const lsOut = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
        cwd: wt.worktreePath,
        stdio: "pipe",
        timeout: 5000
      }).toString("utf8");
      allFiles = lsOut.split(/\r?\n/).filter(Boolean);
    } catch {}

    if (allFiles.length === 0) {
      const ignoreNames = new Set(["node_modules", ".git", ".venv", "target", "dist", ".cache"]);
      function walk(d, prefix = "") {
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          if (ignoreNames.has(ent.name) || ent.name.startsWith(".")) continue;
          const fullP = path.join(d, ent.name);
          const relP = prefix ? `${prefix}/${ent.name}` : ent.name;
          if (ent.isDirectory()) walk(fullP, relP);
          else if (ent.isFile()) allFiles.push(relP);
        }
      }
      walk(wt.worktreePath);
    }

    let filtered = [];
    if (!fileQuery.trim()) {
      filtered = allFiles;
    } else {
      const cleanQ = fileQuery.trim();
      const hasWildcard = cleanQ.includes("*") || cleanQ.includes("?");
      if (hasWildcard) {
        try {
          const globRx = new RegExp("^" + cleanQ.replace(/([.+^$[\]\\(){}|])/g, "\\$1").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
          filtered = allFiles.filter(f => globRx.test(f) || globRx.test(path.basename(f)));
        } catch {
          filtered = allFiles.filter(f => f.toLowerCase().includes(cleanQ.toLowerCase()));
        }
      } else {
        const lowerQ = cleanQ.toLowerCase();
        filtered = allFiles.filter(f => f.toLowerCase().includes(lowerQ));
      }
    }

    return {
      status: 200,
      data: {
        ok: true,
        tool: "find_files",
        searchRoot: wt.worktreePath,
        files: filtered,
        output: filtered.length > 0 ? filtered.join("\n") : "(no files found)"
      }
    };
  }

  // 11. START PROCESS (P2)
  if (toolName === "start_process") {
    const rawCmd = String(command || content || args.command || "").trim();
    if (!rawCmd) {
      return { status: 400, data: { ok: false, error: "Missing process command" } };
    }
    const gated = await gateCommand({ ...gateCtx, commandText: rawCmd, label: "Process" });
    if (gated) return gated;
    const procId = "proc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
    const procName = String(name || args.name || rawCmd.slice(0, 30));
    const execCwd = wt.worktreePath;
    const child = spawnShellProcessGroup(rawCmd, {
      cwd: execCwd,
      env: buildAgentExecEnv(execCwd, wt.worktreePath)
    });
    const logs = [];
    const MAX_LOG_LINES = 1000;
    const appendLog = (chunk) => {
      const text = chunk.toString("utf8");
      const lines = text.split(/\r?\n/);
      for (const l of lines) {
        if (l) logs.push(`[${new Date().toLocaleTimeString()}] ${l}`);
      }
      if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES);
    };
    if (child.stdout) child.stdout.on("data", appendLog);
    if (child.stderr) child.stderr.on("data", appendLog);
    const procEntry = {
      id: procId,
      name: procName,
      command: rawCmd,
      child,
      pid: child.pid,
      cwd: execCwd,
      botId: botId || "bot_r1",
      logs,
      startedAt: new Date().toISOString(),
      exitCode: null
    };
    child.on("exit", (code, signal) => {
      procEntry.exitCode = code !== null ? code : signal;
      logs.push(`[SYSTEM] Process exited with ${code !== null ? `code ${code}` : `signal ${signal}`}`);
    });
    agentBackgroundProcesses.set(procId, procEntry);
    return {
      status: 200,
      data: {
        ok: true,
        tool: "start_process",
        processId: procId,
        pid: child.pid,
        name: procName,
        command: rawCmd,
        status: "running",
        output: `Started background process ${procId} (PID: ${child.pid}): ${rawCmd}`
      }
    };
  }

  // 12. STOP PROCESS (P2)
  if (toolName === "stop_process") {
    const targetId = String(processId || args.processId || name || args.name || "").trim();
    if (!targetId) {
      return { status: 400, data: { ok: false, error: "Missing processId" } };
    }
    let found = agentBackgroundProcesses.get(targetId);
    if (!found) {
      for (const p of agentBackgroundProcesses.values()) {
        if (p.name === targetId || String(p.pid) === targetId) {
          found = p;
          break;
        }
      }
    }
    if (!found) {
      return { status: 200, data: { ok: false, error: `Background process not found: ${targetId}` } };
    }
    killProcessTree(found.child);
    return {
      status: 200,
      data: {
        ok: true,
        tool: "stop_process",
        processId: found.id,
        pid: found.pid,
        status: "stopped",
        output: `Stopped background process ${found.id} (PID ${found.pid})`
      }
    };
  }

  // 13. GET PROCESS LOGS (P2)
  if (toolName === "get_process_logs") {
    const targetId = String(processId || args.processId || name || args.name || "").trim();
    let found = agentBackgroundProcesses.get(targetId);
    if (!found) {
      for (const p of agentBackgroundProcesses.values()) {
        if (p.name === targetId || String(p.pid) === targetId) {
          found = p;
          break;
        }
      }
    }
    if (!found) {
      return { status: 200, data: { ok: false, error: `Background process not found: ${targetId}` } };
    }
    const numLines = parseInt(lines || args.lines || 50, 10) || 50;
    const tail = found.logs.slice(-numLines);
    return {
      status: 200,
      data: {
        ok: true,
        tool: "get_process_logs",
        processId: found.id,
        status: found.exitCode === null ? "running" : `exited (${found.exitCode})`,
        output: tail.length > 0 ? tail.join("\n") : "(no logs yet)"
      }
    };
  }

  // 14. VERIFY PROJECT (P2)
  if (toolName === "verify_project") {
    let verifyCmd = String(command || content || args.command || "").trim();
    const execCwd = wt.worktreePath;
    if (!verifyCmd) {
      if (fs.existsSync(path.join(execCwd, "run.sh"))) verifyCmd = "./run.sh";
      else if (fs.existsSync(path.join(execCwd, "package.json"))) verifyCmd = "npm test";
      else if (fs.existsSync(path.join(execCwd, "pytest.ini")) || fs.existsSync(path.join(execCwd, "tests"))) verifyCmd = "pytest";
      else verifyCmd = "git status";
    }
    const gated = await gateCommand({ ...gateCtx, commandText: verifyCmd, label: "Verification command" });
    if (gated) return gated;
    const execRes = await spawnCommandAsync(verifyCmd, {
      cwd: execCwd,
      worktreePath: wt.worktreePath,
      timeout: 120000,
      trackKey: botId || "bot_r1",
      onProgress: (chunk, tailOutput) => {
        if (streamId) {
          broadcastEvent("tool_stream", {
            streamId,
            threadId,
            botId: botId || "bot_r1",
            botName: botName || "R1",
            command: verifyCmd,
            cwd: execCwd,
            branch: wt.branch,
            chunk,
            output: tailOutput
          });
        }
      }
    });
    return {
      status: 200,
      data: {
        ok: execRes.exitCode === 0,
        exitCode: execRes.exitCode,
        command: verifyCmd,
        output: (execRes.output || `(exit ${execRes.exitCode})`).slice(-15000)
      }
    };
  }

  // 15. SPAWN SUBAGENT (P4)
  if (toolName === "spawn_subagent") {
    const subType = String(args.type || content || "general").toLowerCase();
    const subRole = String(args.role || name || "Subagent");
    const subPrompt = String(args.prompt || content || "");
    if (!subPrompt) return { status: 400, data: { ok: false, error: "Missing subagent prompt" } };
    const sub = await spawnSubagentAsync({
      type: subType,
      role: subRole,
      prompt: subPrompt,
      leadBotId: botId || "bot_r1",
      leadBotName: botName || "R1",
      projectPath: wt.projectRoot
    });
    return {
      status: 200,
      data: {
        ok: true,
        tool: "spawn_subagent",
        subagentId: sub.id,
        type: sub.type,
        role: sub.role,
        branch: sub.branch,
        status: "started",
        output: `Spawned ${sub.type.toUpperCase()} subagent '${sub.role}' (${sub.id}) in isolated worktree ${sub.branch}.`
      }
    };
  }

  // 16. GET SUBAGENT OUTPUT (P4)
  if (toolName === "get_subagent_output") {
    const targetId = String(args.subagentId || processId || content || "").trim();
    if (!targetId) return { status: 400, data: { ok: false, error: "Missing subagentId" } };
    const sub = activeSubagents.get(targetId);
    if (!sub) return { status: 200, data: { ok: false, error: `Subagent not found: ${targetId}` } };
    return {
      status: 200,
      data: {
        ok: true,
        tool: "get_subagent_output",
        subagentId: sub.id,
        status: sub.status,
        step: sub.currentStep,
        maxSteps: sub.maxSteps,
        output: sub.output || `(Subagent status: ${sub.status})`,
        reasoning: sub.reasoning || ""
      }
    };
  }

  // 17. LIST SUBAGENTS (P4)
  if (toolName === "list_subagents") {
    const all = Array.from(activeSubagents.values()).map(s => ({
      id: s.id,
      type: s.type,
      role: s.role,
      status: s.status,
      step: s.currentStep,
      output: (s.output || "").slice(0, 150)
    }));
    return {
      status: 200,
      data: {
        ok: true,
        tool: "list_subagents",
        count: all.length,
        subagents: all,
        output: all.length > 0 ? all.map(s => `[${s.type.toUpperCase()}] ${s.role} (${s.id}): ${s.status}`).join("\n") : "(no active subagents)"
      }
    };
  }

  return { status: 400, data: { error: `Unknown agent tool: ${toolName}` } };
}

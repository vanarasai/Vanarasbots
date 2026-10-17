// Server-side autonomous turn loop (survives UI reloads).
import { execSync } from "node:child_process";
import { loadAgentConfig } from "./agent-store.mjs";
import { executeAgentToolInternal } from "./agent-tools.mjs";
import { compactMessagesList } from "./context.mjs";
import { broadcastEvent } from "./events.mjs";
import { queryLLMInternal } from "./llm.mjs";
import { VANARAS_NATIVE_TOOLS, parseDeliverableBlocksText, parseTextToolCalls } from "./native-tools.mjs";
import { activeServerTurns, sessionCheckpoints } from "./state.mjs";
import { resolveVaultApiKey } from "./vault.mjs";
import { loadWorkspaceDiskState, saveWorkspaceDiskState } from "./workspace-state.mjs";
import { ensureAgentWorktree } from "./worktree.mjs";

// 6B-3. Server-Side Session Turn Execution Loop (P1a, P1b, P2)
export async function executeServerSessionTurn({
  threadId = "default_thread",
  botId = "bot_r1",
  botName = "R1",
  prompt = "",
  systemPrompt = "",
  verifyCommand = "",
  maxSteps = 30
}) {
  const turnRecord = {
    threadId,
    botId,
    botName,
    prompt,
    verifyCommand,
    step: 0,
    maxSteps: Math.max(1, Math.min(100, maxSteps)),
    status: "running",
    message: `Turn initialized for ${botName}`,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    toolCalls: [],
    finalContent: "",
    reasoning: "",
    abortController: new AbortController()
  };
  activeServerTurns.set(threadId, turnRecord);

  let state = loadWorkspaceDiskState() || { threads: [], bots: [] };
  let thread = (state.threads || []).find(t => t.id === threadId);
  if (!thread) {
    thread = {
      id: threadId,
      title: prompt.slice(0, 40) || "Session Turn",
      botId,
      messages: [],
      createdAt: new Date().toISOString()
    };
    state.threads = state.threads || [];
    state.threads.unshift(thread);
  }

  const agentCfg = loadAgentConfig(botId) || {};
  const botDef = (state.bots || []).find(b => b.id === botId) || {};
  const provider = botDef.provider || agentCfg.provider || "local";
  const baseUrl = botDef.baseUrl || agentCfg.baseUrl || (provider === "local" ? "http://127.0.0.1:1234/v1" : "https://openrouter.ai/api/v1");
  const model = botDef.model || agentCfg.model || "";
  const apiKey = resolveVaultApiKey(provider, botDef.apiKey || agentCfg.apiKey || "", botId);

  const lastMsg = thread.messages[thread.messages.length - 1];
  if (prompt && (!lastMsg || lastMsg.role !== "user" || lastMsg.content !== prompt)) {
    thread.messages.push({
      id: "msg_user_" + Date.now(),
      role: "user",
      content: prompt,
      timestamp: new Date().toISOString()
    });
  }
  saveWorkspaceDiskState(state);

  // P3: Session Checkpoint before turn execution
  const wt = ensureAgentWorktree(botId || "bot_r1", botName || "R1");
  let preTurnSha = "";
  try {
    preTurnSha = execSync("git rev-parse HEAD", { cwd: wt.worktreePath, stdio: "pipe", timeout: 4000 }).toString().trim();
  } catch {}

  const checkpointId = `chk_${threadId}_${Date.now()}`;
  const checkpoint = {
    checkpointId,
    threadId,
    botId,
    botName,
    preTurnSha,
    messagesCount: (thread?.messages || []).length,
    timestamp: new Date().toISOString()
  };
  if (!sessionCheckpoints.has(threadId)) {
    sessionCheckpoints.set(threadId, []);
  }
  const chkList = sessionCheckpoints.get(threadId);
  chkList.push(checkpoint);
  if (chkList.length > 30) chkList.shift();

  broadcastEvent("turn_progress", {
    threadId,
    botId,
    step: 0,
    maxSteps: turnRecord.maxSteps,
    status: "running",
    message: `Starting autonomous turn for ${botName} (${turnRecord.maxSteps} max steps)...`
  });

  const effectiveSysPrompt = systemPrompt || botDef.systemPrompt || agentCfg.systemPrompt ||
    `You are ${botName}, an expert autonomous software engineer working in your isolated git worktree.\nYour mission is to plan, inspect files, edit code surgically, run tests/verifications, and fix all errors until working end-to-end.\nAlways verify your changes before declaring completion.`;

  const conversationMessages = [
    { role: "system", content: effectiveSysPrompt },
    ...thread.messages.slice(-20).map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content || ""
    }))
  ];

  // P3: Auto-compaction if conversation messages exceed threshold
  if (conversationMessages.length > 16) {
    const compactRes = compactMessagesList(conversationMessages, 6);
    if (compactRes.compacted) {
      conversationMessages.length = 0;
      conversationMessages.push(...compactRes.messages);
      broadcastEvent("session_compacted", {
        threadId,
        botId,
        compactedTurnsCount: compactRes.compactedTurnsCount,
        newCount: conversationMessages.length
      });
    }
  }

  let accumulatedReasoning = "";
  let finalVisibleContent = "";
  let verifyRunCount = 0;

  try {
    for (let step = 0; step < turnRecord.maxSteps; step++) {
      if (turnRecord.abortController.signal.aborted) {
        turnRecord.status = "stopped";
        turnRecord.message = "Turn stopped by user";
        break;
      }
      turnRecord.step = step + 1;
      turnRecord.updatedAt = new Date().toISOString();
      turnRecord.message = `${botName} thinking (Step ${turnRecord.step}/${turnRecord.maxSteps})...`;

      broadcastEvent("turn_progress", {
        threadId,
        botId,
        step: turnRecord.step,
        maxSteps: turnRecord.maxSteps,
        status: "thinking",
        message: turnRecord.message
      });

      const llmRes = await queryLLMInternal({
        provider,
        baseUrl,
        apiKey,
        botId,
        model,
        messages: conversationMessages,
        temperature: 0.2,
        max_tokens: 8192,
        enableReasoning: true,
        tools: VANARAS_NATIVE_TOOLS,
        signal: turnRecord.abortController.signal
      });

      if (turnRecord.abortController.signal.aborted) {
        turnRecord.status = "stopped";
        turnRecord.message = "Turn stopped by user";
        break;
      }

      const replyContent = llmRes.content || "";
      const replyReasoning = llmRes.reasoning || "";
      if (replyReasoning) {
        accumulatedReasoning = [accumulatedReasoning, replyReasoning].filter(Boolean).join("\n\n---\n\n");
        turnRecord.reasoning = accumulatedReasoning;
      }

      const nativeToolCalls = Array.isArray(llmRes.tool_calls) && llmRes.tool_calls.length > 0 ? llmRes.tool_calls : [];
      const textToolCalls = parseTextToolCalls(replyContent);
      const filesToWrite = parseDeliverableBlocksText(replyContent);

      const allToolCalls = [...nativeToolCalls];
      for (const tt of textToolCalls) {
        allToolCalls.push({
          id: "call_txt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
          type: "function",
          function: { name: tt.tool, arguments: JSON.stringify(tt.args) }
        });
      }
      for (const f of filesToWrite) {
        allToolCalls.push({
          id: "call_file_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
          type: "function",
          function: { name: "fs_write", arguments: JSON.stringify({ filePath: f.name, content: f.content }) }
        });
      }

      if (allToolCalls.length === 0) {
        if (verifyCommand && verifyRunCount === 0) {
          verifyRunCount++;
          turnRecord.message = `${botName} running project verification (${verifyCommand})...`;
          broadcastEvent("turn_progress", {
            threadId,
            botId,
            step: turnRecord.step,
            maxSteps: turnRecord.maxSteps,
            status: "verifying",
            message: turnRecord.message
          });
          const vResult = await executeAgentToolInternal({
            botId,
            botName,
            tool: "verify_project",
            command: verifyCommand,
            threadId
          });
          const vOut = vResult.data || vResult;
          if (!vOut.ok) {
            conversationMessages.push({
              role: "assistant",
              content: replyContent
            });
            conversationMessages.push({
              role: "user",
              content: `[VERIFICATION FAILED (exit code ${vOut.exitCode})]:\n${vOut.output}\nPlease fix the failing code, re-verify with verify_project or shell_exec, and ensure it passes.`
            });
            continue;
          }
        }

        finalVisibleContent = replyContent;
        break;
      }

      const executedToolResults = [];
      for (const tc of allToolCalls) {
        if (turnRecord.abortController.signal.aborted) break;
        const fnName = tc.function?.name || tc.name;
        let fnArgs = {};
        try {
          fnArgs = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
        } catch {}

        turnRecord.message = `${botName} executing ${fnName}...`;
        broadcastEvent("turn_progress", {
          threadId,
          botId,
          step: turnRecord.step,
          maxSteps: turnRecord.maxSteps,
          status: "tool_exec",
          toolCall: { name: fnName, args: fnArgs },
          message: turnRecord.message
        });

        const toolRes = await executeAgentToolInternal({
          botId,
          botName,
          tool: fnName,
          args: fnArgs,
          ...fnArgs,
          threadId
        });

        const outputStr = toolRes.data?.output !== undefined ? String(toolRes.data.output) : JSON.stringify(toolRes.data || toolRes);
        executedToolResults.push({
          toolCallId: tc.id,
          name: fnName,
          output: outputStr
        });
        turnRecord.toolCalls.push({ step: turnRecord.step, name: fnName, args: fnArgs, output: outputStr });
      }

      if (nativeToolCalls.length > 0) {
        conversationMessages.push({
          role: "assistant",
          content: replyContent || null,
          tool_calls: nativeToolCalls
        });
        for (const resItem of executedToolResults) {
          conversationMessages.push({
            role: "tool",
            tool_call_id: resItem.toolCallId,
            content: resItem.output
          });
        }
      } else {
        conversationMessages.push({
          role: "assistant",
          content: replyContent
        });
        const combinedOutputs = executedToolResults.map(r => `[Tool Output: ${r.name}]\n${r.output}`).join("\n\n");
        conversationMessages.push({
          role: "user",
          content: `Real execution output from your worktree:\n${combinedOutputs}\nUse the tool output above to continue the task.`
        });
      }
    }

    if (turnRecord.status !== "stopped") {
      turnRecord.status = "completed";
      turnRecord.message = "Turn completed successfully";
    }
  } catch (err) {
    turnRecord.status = "error";
    turnRecord.error = err.message;
    turnRecord.message = `Turn error: ${err.message}`;
    finalVisibleContent = (finalVisibleContent ? finalVisibleContent + "\n\n" : "") + `Error during session execution: ${err.message}`;
  }

  turnRecord.finalContent = finalVisibleContent;
  turnRecord.updatedAt = new Date().toISOString();

  state = loadWorkspaceDiskState() || state;
  thread = (state.threads || []).find(t => t.id === threadId);
  if (thread) {
    thread.messages.push({
      id: "msg_ast_" + Date.now(),
      role: "assistant",
      botId,
      botName,
      content: finalVisibleContent,
      reasoning: accumulatedReasoning,
      toolCalls: turnRecord.toolCalls,
      timestamp: new Date().toISOString()
    });
    saveWorkspaceDiskState(state);
  }

  broadcastEvent("turn_complete", {
    threadId,
    botId,
    botName,
    status: turnRecord.status,
    finalContent: finalVisibleContent,
    reasoning: accumulatedReasoning,
    toolCallsCount: turnRecord.toolCalls.length
  });

  return turnRecord;
}

// Server-side autonomous turn loop (survives UI reloads).
import { execSync } from "node:child_process";
import { loadAgentConfig } from "./agent-store.mjs";
import { executeAgentToolInternal } from "./agent-tools.mjs";
import { compactMessagesList, detectUnfulfilledAction, threadMessagesToChat } from "./context.mjs";
import { broadcastEvent } from "./events.mjs";
import { queryLLMInternal } from "./llm.mjs";
import { VANARAS_NATIVE_TOOLS, parseDeliverableBlocksText, parseRememberDirectives, parseSurgicalPatchesText, parseTextToolCalls } from "./native-tools.mjs";
import { activeServerTurns, sessionCheckpoints, serverTurnKey } from "./state.mjs";
import { resolveVaultApiKey } from "./vault.mjs";
import { loadWorkspaceDiskState, saveWorkspaceDiskState } from "./workspace-state.mjs";
import { ensureAgentWorktree } from "./worktree.mjs";

// 6B-3. Server-Side Session Turn Execution Loop (P1a, P1b, P2)
// Appended to every agent's system prompt (including user-defined ones) so claims are backed by evidence.
const EVIDENCE_RULES = `

EVIDENCE RULES (always apply):
- Never state a cause, status or result you have not just observed. Run the check first, then quote the relevant output.
- Tool output is stamped with when it was captured. Treat anything older than your latest step as stale and re-run the check before relying on it (ports, processes, files and servers change).
- When a command fails, read its error, diagnose that error, and try the next concrete step yourself. Do not stop to ask permission for routine, non-destructive diagnostics.
- If a fix needs something you cannot do (credentials, a download you are not allowed to run), say exactly what is missing and what you already verified.
- A successful-looking artifact is not proof. Verify real behaviour (run it and check what it actually produces, not just that a file exists) before saying it works.`;

// How many times one turn may be pushed to act after announcing work without a tool call.
const MAX_NUDGES = 2;

// One step as the chat shows it: what ran and the tail of its output (the end of a log is where the result
// and the error usually are). Full output stays on the turn record for the agent itself.
export function summarizeToolStep(call, seq, maxOutput = 1500) {
  const a = call.args || {};
  const target = a.command ?? a.filePath ?? a.path ?? a.pattern ?? a.query ?? a.processId ?? a.prompt ?? a.message;
  const output = String(call.output ?? "");
  return {
    seq,
    step: call.step,
    name: call.name,
    target: String(target !== undefined ? target : (Object.keys(a).length ? JSON.stringify(a) : "")).slice(0, 400),
    output: output.length > maxOutput ? `…${output.slice(-maxOutput)}` : output
  };
}

const freshOutput = (out) => `[output captured ${new Date().toISOString()}]\n${out}`;

// The model an agent talks to: its definition in the workspace (what the UI edits) first, then its saved
// agent config, then the provider default. Shared by session turns and panels.
export function resolveAgentModel(botId, state = loadWorkspaceDiskState() || {}) {
  const agentCfg = loadAgentConfig(botId) || {};
  const botDef = (state.bots || []).find(b => b.id === botId) || {};
  const provider = botDef.provider || agentCfg.provider || "local";
  const baseUrl = botDef.baseUrl || agentCfg.baseUrl || (provider === "local" ? "http://127.0.0.1:1234/v1" : "https://openrouter.ai/api/v1");
  const model = botDef.model || agentCfg.model || "";
  const apiKey = resolveVaultApiKey(provider, botDef.apiKey || agentCfg.apiKey || "", botId);
  return { agentCfg, botDef, provider, baseUrl, model, apiKey };
}

// A failed model call used to read as an empty reply, which ended the turn as if the agent had finished.
// Retry transient failures (rate limits, overloaded providers, 5xx, dropped connections) with growing waits,
// then fail with the reason. `retries` is how many extra attempts to make (default one).
export async function queryModelWithRetry(params, { retries = 1 } = {}) {
  const wait = (attempt) => new Promise(r => setTimeout(r, Math.min(20000, 3000 * 2 ** (attempt - 1))));
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await queryLLMInternal(params);
    } catch (err) {
      if (params.signal?.aborted || attempt > retries) throw err;
      await wait(attempt);
      continue;
    }
    if (res && res.ok === false) {
      const transient = res.status === 408 || res.status === 429 || res.status >= 500;
      if (transient && attempt <= retries && !params.signal?.aborted) {
        await wait(attempt);
        continue;
      }
      throw new Error(`Model request failed: ${String(res.error || `HTTP ${res.status}`).slice(0, 500)}`);
    }
    return res;
  }
}

export async function executeServerSessionTurn({
  threadId = "default_thread",
  botId = "bot_r1",
  botName = "R1",
  prompt = "",
  systemPrompt = "",
  verifyCommand = "",
  maxSteps = 30,
  turnId = "",
  disabledTools = [],
  projectPath = ""
}) {
  // Tools withheld from this turn: not offered to the model, and refused if it asks for them anyway.
  const withheld = new Set((Array.isArray(disabledTools) ? disabledTools : []).map(String));
  const offeredTools = VANARAS_NATIVE_TOOLS.filter(t => !withheld.has(t.function?.name));
  const turnRecord = {
    turnId,
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
    usage: { prompt: 0, completion: 0, calls: 0, reported: 0, toolOutputChars: 0 },
    remembered: [],
    finalContent: "",
    reasoning: "",
    abortController: new AbortController()
  };
  activeServerTurns.set(serverTurnKey(threadId, botId), turnRecord);

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

  const { agentCfg, botDef, provider, baseUrl, model, apiKey } = resolveAgentModel(botId, state);

  const lastMsg = thread.messages[thread.messages.length - 1];
  if (prompt && (!lastMsg || (lastMsg.role !== "user" && lastMsg.senderType !== "user") || (lastMsg.content !== prompt && lastMsg.text !== prompt))) {
    thread.messages.push({
      id: "msg_user_" + Date.now(),
      role: "user",
      senderType: "user",
      content: prompt,
      text: prompt,
      timestamp: new Date().toISOString()
    });
  }
  saveWorkspaceDiskState(state);

  // The turn works on the room's project: the explicit projectPath, else the room's folder.
  let wt;
  try {
    wt = ensureAgentWorktree(botId || "bot_r1", botName || "R1", projectPath || thread.mountPath || "");
  } catch (err) {
    turnRecord.status = "error";
    turnRecord.error = err.message;
    turnRecord.message = `Turn error: ${err.message}`;
    turnRecord.finalContent = `This room has no usable project folder: ${err.message}`;
    turnRecord.updatedAt = new Date().toISOString();
    broadcastEvent("turn_complete", { turnId, threadId, botId, botName, status: "error", finalContent: turnRecord.finalContent, reasoning: "", toolCallsCount: 0, toolCalls: [], remembered: [] });
    return turnRecord;
  }

  // P3: Session Checkpoint before turn execution
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
    worktreePath: wt.worktreePath,
    projectRoot: wt.projectRoot,
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
    turnId,
    threadId,
    botId,
    step: 0,
    maxSteps: turnRecord.maxSteps,
    status: "running",
    message: `Starting autonomous turn for ${botName} (${turnRecord.maxSteps} max steps)...`
  });

  const baseSysPrompt = systemPrompt || botDef.systemPrompt || agentCfg.systemPrompt ||
    `You are ${botName}, an expert autonomous software engineer working in your isolated git worktree.\nYour mission is to plan, inspect files, edit code surgically, run tests/verifications, and fix all errors until working end-to-end.\nAlways verify your changes before declaring completion.`;
    const effectiveSysPrompt = baseSysPrompt + EVIDENCE_RULES;

  const conversationMessages = [
    { role: "system", content: effectiveSysPrompt },
    ...threadMessagesToChat(
      thread.messages.slice(-20),
      botId,
      Object.fromEntries((state.bots || []).map(b => [b.id, b.name]))
    )
  ];

  // P3: Auto-compaction if conversation messages exceed threshold
  if (conversationMessages.length > 16) {
    const compactRes = compactMessagesList(conversationMessages, 6);
    if (compactRes.compacted) {
      conversationMessages.length = 0;
      conversationMessages.push(...compactRes.messages);
      broadcastEvent("session_compacted", {
        turnId,
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
  let nudgeCount = 0;
  let reminderIndex = -1;

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
        turnId,
        threadId,
        botId,
        step: turnRecord.step,
        maxSteps: turnRecord.maxSteps,
        status: "thinking",
        message: turnRecord.message
      });

      const llmRes = await queryModelWithRetry({
        provider,
        baseUrl,
        apiKey,
        botId,
        model,
        messages: conversationMessages,
        temperature: 0.2,
        max_tokens: 8192,
        enableReasoning: true,
        tools: offeredTools,
        signal: turnRecord.abortController.signal
      });
      turnRecord.usage.calls++;
      if (llmRes.usage) {
        turnRecord.usage.reported++;
        turnRecord.usage.prompt += llmRes.usage.prompt;
        turnRecord.usage.completion += llmRes.usage.completion;
      }

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
      for (const e of parseSurgicalPatchesText(replyContent)) {
        allToolCalls.push({
          id: "call_patch_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
          type: "function",
          function: { name: "exact_edit", arguments: JSON.stringify(e) }
        });
      }
      for (const fact of parseRememberDirectives(replyContent)) {
        if (!turnRecord.remembered.includes(fact)) turnRecord.remembered.push(fact);
      }
      for (const f of filesToWrite) {
        allToolCalls.push({
          id: "call_file_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
          type: "function",
          function: { name: "fs_write", arguments: JSON.stringify({ filePath: f.name, content: f.content }) }
        });
      }

      if (allToolCalls.length === 0) {
        const unfulfilled = detectUnfulfilledAction(replyContent);
        if (unfulfilled && nudgeCount < MAX_NUDGES && step < turnRecord.maxSteps - 1) {
          nudgeCount++;
          conversationMessages.push({ role: "assistant", content: replyContent });
          conversationMessages.push({
            role: "user",
            content: `[RUNNER] ${unfulfilled} Call the tool now (prefer a native tool call; for a text tag, keep every [ and ] balanced), or, if the task is finished or blocked, say so plainly with the evidence.`
          });
          broadcastEvent("turn_progress", {
            turnId,
            threadId,
            botId,
            step: turnRecord.step,
            maxSteps: turnRecord.maxSteps,
            status: "thinking",
            message: `${botName} announced work without running it; asking it to continue...`
          });
          continue;
        }
        if (verifyCommand && verifyRunCount === 0) {
          verifyRunCount++;
          turnRecord.message = `${botName} running project verification (${verifyCommand})...`;
          broadcastEvent("turn_progress", {
            turnId,
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
            threadId,
            projectPath: wt.projectRoot
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

        const preview = summarizeToolStep({ name: fnName, args: fnArgs }, turnRecord.toolCalls.length).target;
        turnRecord.message = `${botName} running ${fnName}${preview ? `: ${preview.replace(/\s+/g, " ").slice(0, 90)}` : ""}…`;
        broadcastEvent("turn_progress", {
          turnId,
          threadId,
          botId,
          step: turnRecord.step,
          maxSteps: turnRecord.maxSteps,
          status: "tool_exec",
          toolCall: { name: fnName, args: fnArgs },
          message: turnRecord.message
        });

        const toolRes = withheld.has(fnName)
          ? { status: 200, data: { ok: false, error: `${fnName} is not available in this turn.` } }
          : await executeAgentToolInternal({
            botId,
            botName,
            tool: fnName,
            args: fnArgs,
            ...fnArgs,
            threadId,
            // After the model's arguments, so a tool call cannot point the agent at another folder.
            projectPath: wt.projectRoot
          });

        const outputStr = toolRes.data?.output !== undefined ? String(toolRes.data.output) : JSON.stringify(toolRes.data || toolRes);
        executedToolResults.push({
          toolCallId: tc.id,
          name: fnName,
          output: outputStr
        });
        turnRecord.toolCalls.push({ step: turnRecord.step, name: fnName, args: fnArgs, output: outputStr });
        turnRecord.usage.toolOutputChars += outputStr.length;
        broadcastEvent("turn_progress", {
          turnId,
          threadId,
          botId,
          step: turnRecord.step,
          maxSteps: turnRecord.maxSteps,
          status: "tool_result",
          toolResult: summarizeToolStep(turnRecord.toolCalls[turnRecord.toolCalls.length - 1], turnRecord.toolCalls.length - 1),
          message: turnRecord.message
        });
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
            content: freshOutput(resItem.output)
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
          content: `Real execution output captured at ${new Date().toISOString()} (earlier outputs may be stale; re-run a check before relying on it):\n${combinedOutputs}\nUse the tool output above to continue the task.`
        });
      }
      // After pages of tool output, smaller models answer the output instead of the request (in an A/B run a
      // 9B model reviewed the code it had read, or talked about audio, instead of answering the question).
      // Restate the request after each round of results; only the latest reminder is kept, so it costs one
      // short message, not one per step.
      if (prompt) {
        if (reminderIndex >= 0) conversationMessages.splice(reminderIndex, 1);
        conversationMessages.push({
          role: "user",
          content: `[RUNNER] Task reminder. The request you are working on:\n"${String(prompt).slice(0, 1500)}"\nContinue with tools if you still need evidence; otherwise answer that request directly.`
        });
        reminderIndex = conversationMessages.length - 1;
      }
    }

    if (turnRecord.status !== "stopped" && !finalVisibleContent) {
      // The loop ran out of steps while the agent was still working: say so instead of a silent "(Completed)".
      const lastTool = turnRecord.toolCalls[turnRecord.toolCalls.length - 1];
      turnRecord.status = "incomplete";
      turnRecord.message = `Reached the ${turnRecord.maxSteps}-step limit`;
      finalVisibleContent = `Paused after reaching the ${turnRecord.maxSteps}-step limit before finishing${lastTool ? ` (last action: ${lastTool.name})` : ""}. Reply "continue" to resume.`;
    } else if (turnRecord.status !== "stopped") {
      turnRecord.status = "completed";
      turnRecord.message = "Turn completed successfully";
    }
  } catch (err) {
    if (turnRecord.abortController.signal.aborted) {
      // Stopping aborts an in-flight model request; that is a stop, not an error.
      turnRecord.status = "stopped";
      turnRecord.message = "Turn stopped";
    } else {
      turnRecord.status = "error";
      turnRecord.error = err.message;
      turnRecord.message = `Turn error: ${err.message}`;
      finalVisibleContent = (finalVisibleContent ? finalVisibleContent + "\n\n" : "") + `Error during session execution: ${err.message}`;
    }
  }

  turnRecord.finalContent = finalVisibleContent;
  turnRecord.updatedAt = new Date().toISOString();

  state = loadWorkspaceDiskState() || state;
  thread = (state.threads || []).find(t => t.id === threadId);
  if (thread) {
    thread.messages.push({
      id: "msg_ast_" + Date.now(),
      role: "assistant",
      senderType: "bot",
      botId,
      botName,
      content: finalVisibleContent,
      text: finalVisibleContent,
      reasoning: accumulatedReasoning,
      toolCalls: turnRecord.toolCalls,
      timestamp: new Date().toISOString()
    });
    saveWorkspaceDiskState(state);
  }

  broadcastEvent("turn_complete", {
    turnId,
    threadId,
    botId,
    botName,
    status: turnRecord.status,
    finalContent: finalVisibleContent,
    reasoning: accumulatedReasoning,
    toolCallsCount: turnRecord.toolCalls.length,
    toolCalls: turnRecord.toolCalls.map((c, i) => summarizeToolStep(c, i)),
    remembered: turnRecord.remembered
  });

  return turnRecord;
}

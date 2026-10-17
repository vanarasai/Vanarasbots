// Dynamic explore/plan/general subagents running in isolated worktrees.
import { loadAgentConfig } from "./agent-store.mjs";
import { executeAgentToolInternal } from "./agent-tools.mjs";
import { broadcastEvent } from "./events.mjs";
import { queryLLMInternal } from "./llm.mjs";
import { VANARAS_NATIVE_TOOLS, parseDeliverableBlocksText, parseTextToolCalls } from "./native-tools.mjs";
import { activeSubagents } from "./state.mjs";
import { resolveVaultApiKey } from "./vault.mjs";
import { loadWorkspaceDiskState } from "./workspace-state.mjs";
import { ensureAgentWorktree } from "./worktree.mjs";

// 6D-1. Dynamic Subagent Spawning Engine (P4)
export async function spawnSubagentAsync({
  type = "general",
  role = "Subagent",
  prompt = "",
  leadBotId = "bot_r1",
  leadBotName = "R1",
  maxSteps = null
}) {
  const cleanType = ["explore", "plan", "general"].includes(String(type).toLowerCase()) ? String(type).toLowerCase() : "general";
  const subagentId = `sub_${cleanType}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const effectiveRole = role || (cleanType === "explore" ? "Codebase Explorer" : cleanType === "plan" ? "Architecture Planner" : "General Implementer");

  const wt = ensureAgentWorktree(subagentId, effectiveRole);
  const effectiveMaxSteps = Number(maxSteps) || (cleanType === "explore" ? 10 : cleanType === "plan" ? 8 : 20);

  const subRecord = {
    id: subagentId,
    type: cleanType,
    role: effectiveRole,
    prompt,
    leadBotId,
    leadBotName,
    status: "running",
    currentStep: 0,
    maxSteps: effectiveMaxSteps,
    worktreePath: wt.worktreePath,
    branch: wt.branch,
    codeDir: wt.codeDir,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logs: [],
    toolCalls: [],
    output: "",
    reasoning: "",
    abortController: new AbortController()
  };
  activeSubagents.set(subagentId, subRecord);

  broadcastEvent("subagent_spawned", {
    subagentId,
    type: cleanType,
    role: effectiveRole,
    branch: wt.branch,
    leadBotId,
    prompt: prompt.slice(0, 100),
    status: "running"
  });

  (async () => {
    try {
      let subTools = VANARAS_NATIVE_TOOLS;
      if (cleanType === "explore") {
        subTools = VANARAS_NATIVE_TOOLS.filter(t => ["fs_read", "grep_search", "find_files", "git_status", "git_diff"].includes(t.function.name));
      } else if (cleanType === "plan") {
        subTools = VANARAS_NATIVE_TOOLS.filter(t => ["fs_read", "grep_search", "find_files"].includes(t.function.name));
      }

      let sysPrompt = "";
      if (cleanType === "explore") {
        sysPrompt = `You are ${effectiveRole}, an Explore Subagent specializing in read-only codebase navigation, search, and fact gathering.\nYour isolated worktree is on branch ${wt.branch}.\nYou have read-only access: use grep_search, find_files, and fs_read to investigate and gather facts thoroughly.\nYou CANNOT write files or execute mutation commands.\nReport your findings with concrete file paths, line numbers, and concise summaries.`;
      } else if (cleanType === "plan") {
        sysPrompt = `You are ${effectiveRole}, a Plan Subagent specializing in software planning and breakdown.\nYour task is to analyze requirements, inspect files if needed, and produce a structured, phased implementation plan with exact steps and verification checks.`;
      } else {
        sysPrompt = `You are ${effectiveRole}, a General Subagent working in your dedicated isolated git worktree (${wt.branch}).\nYou have full authority to inspect, edit (using exact_edit or fs_write), and verify code in your worktree.\nReport all results and changes clearly.`;
      }

      const conversation = [
        { role: "system", content: sysPrompt },
        { role: "user", content: prompt }
      ];

      const state = loadWorkspaceDiskState() || {};
      const botDef = (state.bots || []).find(b => b.id === leadBotId) || {};
      const agentCfg = loadAgentConfig(leadBotId) || {};
      const provider = botDef.provider || agentCfg.provider || "local";
      const baseUrl = botDef.baseUrl || agentCfg.baseUrl || (provider === "local" ? "http://127.0.0.1:1234/v1" : "https://openrouter.ai/api/v1");
      const model = botDef.model || agentCfg.model || "";
      const apiKey = resolveVaultApiKey(provider, botDef.apiKey || agentCfg.apiKey || "", leadBotId);

      for (let step = 0; step < effectiveMaxSteps; step++) {
        if (subRecord.abortController.signal.aborted) {
          subRecord.status = "stopped";
          break;
        }
        subRecord.currentStep = step + 1;
        subRecord.updatedAt = new Date().toISOString();

        broadcastEvent("subagent_progress", {
          subagentId,
          step: subRecord.currentStep,
          maxSteps: effectiveMaxSteps,
          status: "thinking",
          message: `${effectiveRole} thinking (Step ${subRecord.currentStep}/${effectiveMaxSteps})...`
        });

        const reply = await queryLLMInternal({
          provider,
          baseUrl,
          apiKey,
          botId: leadBotId,
          model,
          messages: conversation,
          temperature: 0.2,
          max_tokens: 4096,
          enableReasoning: true,
          tools: subTools,
          signal: subRecord.abortController.signal
        });

        if (subRecord.abortController.signal.aborted) {
          subRecord.status = "stopped";
          break;
        }

        const replyContent = reply.content || "";
        const replyReason = reply.reasoning || "";
        if (replyReason) {
          subRecord.reasoning = [subRecord.reasoning, replyReason].filter(Boolean).join("\n\n---\n\n");
        }

        const nativeTools = Array.isArray(reply.tool_calls) && reply.tool_calls.length > 0 ? reply.tool_calls : [];
        const textTools = parseTextToolCalls(replyContent);

        const allTools = [...nativeTools];
        for (const tt of textTools) {
          allTools.push({
            id: "call_sub_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
            type: "function",
            function: { name: tt.tool, arguments: JSON.stringify(tt.args) }
          });
        }

        if (cleanType === "general") {
          const files = parseDeliverableBlocksText(replyContent);
          for (const f of files) {
            allTools.push({
              id: "call_sub_file_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
              type: "function",
              function: { name: "fs_write", arguments: JSON.stringify({ filePath: f.name, content: f.content }) }
            });
          }
        }

        if (allTools.length === 0) {
          subRecord.output = replyContent;
          break;
        }

        const executedResults = [];
        for (const tc of allTools) {
          if (subRecord.abortController.signal.aborted) break;
          const fnName = tc.function?.name || tc.name;
          let fnArgs = {};
          try { fnArgs = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {}); } catch {}

          broadcastEvent("subagent_progress", {
            subagentId,
            step: subRecord.currentStep,
            maxSteps: effectiveMaxSteps,
            status: "tool_exec",
            toolCall: { name: fnName, args: fnArgs },
            message: `${effectiveRole} executing ${fnName}...`
          });

          const tRes = await executeAgentToolInternal({
            botId: subagentId,
            botName: effectiveRole,
            tool: fnName,
            args: fnArgs,
            ...fnArgs
          });

          const outStr = tRes.data?.output !== undefined ? String(tRes.data.output) : JSON.stringify(tRes.data || tRes);
          executedResults.push({ toolCallId: tc.id, name: fnName, output: outStr });
          subRecord.toolCalls.push({ step: subRecord.currentStep, name: fnName, args: fnArgs, output: outStr });
        }

        if (nativeTools.length > 0) {
          conversation.push({ role: "assistant", content: replyContent || null, tool_calls: nativeTools });
          for (const item of executedResults) {
            conversation.push({ role: "tool", tool_call_id: item.toolCallId, content: item.output });
          }
        } else {
          conversation.push({ role: "assistant", content: replyContent });
          const combined = executedResults.map(r => `[Tool Output: ${r.name}]\n${r.output}`).join("\n\n");
          conversation.push({ role: "user", content: `Tool output from ${wt.branch}:\n${combined}\nContinue your task.` });
        }
      }

      if (subRecord.status !== "stopped") {
        subRecord.status = "completed";
      }
    } catch (e) {
      subRecord.status = "error";
      subRecord.error = e.message;
      subRecord.output = (subRecord.output ? subRecord.output + "\n\n" : "") + `Subagent execution error: ${e.message}`;
    }

    subRecord.updatedAt = new Date().toISOString();
    broadcastEvent("subagent_completed", {
      subagentId,
      type: cleanType,
      role: effectiveRole,
      status: subRecord.status,
      output: subRecord.output,
      reasoning: subRecord.reasoning,
      toolCallsCount: subRecord.toolCalls.length
    });
  })();

  return subRecord;
}

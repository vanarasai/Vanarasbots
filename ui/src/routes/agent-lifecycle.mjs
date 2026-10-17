// HTTP routes: /api/agent/hooks, /api/agent/hook, /api/agent/store, /api/agent/watcher, /api/agent/sandbox
import fs from "node:fs";
import path from "node:path";
import { AGENTS_STATE_DIR } from "../config.mjs";
import { splitReasoningAndVisibleOutput } from "../context.mjs";
import { broadcastEvent } from "../events.mjs";
import { readJsonBody, sendJson } from "../http-utils.mjs";
import { killProcessTree } from "../process.mjs";
import { agentDevServers, agentHeartbeats, agentWatchers } from "../state.mjs";
import { getAgentAssignedPort, getHeadSha, sanitizeSlug } from "../util.mjs";
import { ensureAgentWorktree, listAgentCodeFiles, syncWorktreeDeliverablesToMainRoot } from "../worktree.mjs";

export async function handleAgentLifecycleRoutes(req, res) {
  // 2E. Vanaras Local-Exec-Daemon Lifecycle Hooks & PreCompact Engine (/api/agent/hooks)
  if (req.method === "POST" && (req.url === "/api/agent/hooks" || req.url === "/api/agent/hook")) {
    try {
      const bodyObj = await readJsonBody(req);
      const {
        botId = "bot_r1",
        botName = "R1",
        prompt = "",
        toolName = "",
        allowedTools = [],
        disabledTools = [],
        mcpCustomInstructions = "",
        messages = []
      } = bodyObj;
      const hook = bodyObj.hook || bodyObj.hookType || "BeforeSubmitPromptRequest";
      const rawOutput = bodyObj.rawOutput !== undefined ? bodyObj.rawOutput : (bodyObj.content || "");
      const priorReasoning = bodyObj.reasoning || "";

      const wt = ensureAgentWorktree(botId, botName);
      const timestamp = new Date().toISOString();

      // 1. BeforeSubmitPromptRequest: records worktree & AgentStore manifest metadata and applies optional MCP custom instructions
      if (hook === "BeforeSubmitPromptRequest") {
        const files = listAgentCodeFiles(wt.codeDir).map(f => f.name);
        let sanitizedPrompt = String(prompt || "");
        let redactions = 0;
        sanitizedPrompt = sanitizedPrompt.replace(/\b(sk-[a-zA-Z0-9_-]{16,}|ghp_[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z-_]{25,})\b/g, () => {
          redactions++;
          return "[REDACTED_SECRET]";
        });
        const enrichedPrompt = mcpCustomInstructions
          ? `${sanitizedPrompt}\n\n[Additional Instructions: ${mcpCustomInstructions}]`
          : sanitizedPrompt;
        broadcastEvent("agent_hook", { hook, botId, botName, branch: wt.branch, timestamp });
        return sendJson(res, 200, {
          ok: true,
          hook,
          botId,
          branch: wt.branch,
          sandboxManifest: { branch: wt.branch, codeDir: wt.codeDir, files },
          sanitizedPrompt,
          redactions,
          enrichedPrompt,
          timestamp
        });
      }

      // 2. AfterAgentThoughtRequest: extracts <think>...</think> or trailing unclosed <think>... or [THOUGHT: ...] internal reasoning
      if (hook === "AfterAgentThoughtRequest") {
        const { thoughts, reasoning: combinedReasoning, cleanedOutput: finalCleaned } = splitReasoningAndVisibleOutput(rawOutput, priorReasoning);
        broadcastEvent("agent_hook", { hook, botId, botName, thoughtCount: thoughts.length, timestamp });
        return sendJson(res, 200, {
          ok: true,
          hook,
          thoughts,
          reasoning: combinedReasoning,
          cleanedOutput: finalCleaned,
          cleanedContent: finalCleaned,
          timestamp
        });
      }

      // 3. PreToolUseRequest / PostToolUseRequest / PostToolUseFailureRequest
      if (hook === "PreToolUseRequest") {
        const blackListed = Array.isArray(disabledTools) && disabledTools.includes(toolName);
        const permitted = !blackListed && (!Array.isArray(allowedTools) || allowedTools.length === 0 || allowedTools.includes(toolName));
        broadcastEvent("agent_hook", { hook, botId, botName, toolName, permitted, blackListed, timestamp });
        return sendJson(res, 200, {
          ok: permitted,
          hook,
          toolName,
          permitted,
          reason: blackListed
            ? `Blocked by mcpDisabledToolsByServerId (${toolName})`
            : permitted
              ? "Allowed by PreToolUseRequest policy"
              : `Tool '${toolName}' not enabled in ${botName}'s toolset`,
          timestamp
        });
      }

      // 4. PreCompactRequest: structured context-window compaction & summarization
      if (hook === "PreCompactRequest") {
        const msgList = Array.isArray(messages) ? messages : [];
        const olderMessages = msgList.slice(0, Math.max(0, msgList.length - 6));
        const userGoals = [];
        const touchedFiles = new Set();
        const turnNotes = [];

        for (const m of olderMessages) {
          const rawText = String(m.text || "");
          if (m.senderType === "user") {
            const cleanGoal = rawText.replace(/\s+/g, " ").trim().slice(0, 220);
            if (cleanGoal && !userGoals.includes(cleanGoal)) userGoals.push(cleanGoal);
            continue;
          }
          if (m.senderType === "terminal") {
            const cmd = String(m.command || "").trim();
            if (cmd) turnNotes.push(`- [Terminal] ${cmd} (exit ${m.exitCode ?? 0})`);
            continue;
          }
          const fileRx = /===FILE:\s*([^\n=]+?)===|===PATCH:\s*([^\n=]+?)===/gi;
          let fm;
          while ((fm = fileRx.exec(rawText)) !== null) {
            const fName = (fm[1] || fm[2] || "").trim();
            if (fName) touchedFiles.add(fName);
          }
          const strippedCode = rawText
            .replace(/===FILE:\s*[^\n=]+===[\s\S]*?(?:===END_FILE===|$)/gi, "")
            .replace(/===PATCH:\s*[^\n=]+===[\s\S]*?(?:===END_PATCH===|$)/gi, "")
            .replace(/```[\s\S]*?```/g, "")
            .replace(/\s+/g, " ")
            .trim();
          const who = m.botId ? m.botId.replace(/^bot_/, "").toUpperCase() : "Agent";
          if (strippedCode) {
            turnNotes.push(`- ${who}: ${strippedCode.slice(0, 200)}`);
          }
        }

        const digestSections = [];
        if (userGoals.length > 0) {
          digestSections.push(`User Goals: ${userGoals.slice(-3).join(" | ")}`);
        }
        if (touchedFiles.size > 0) {
          digestSections.push(`Files Created/Updated: ${Array.from(touchedFiles).join(", ")}`);
        }
        if (turnNotes.length > 0) {
          digestSections.push(`Key Prior Turns:\n${turnNotes.slice(-10).join("\n")}`);
        }
        const compactDigest = digestSections.length > 0
          ? `[PreCompact Summary of ${olderMessages.length} earlier turns]\n${digestSections.join("\n")}`
          : "Context window is already compact.";
        broadcastEvent("agent_hook", { hook, botId, botName, compactedCount: olderMessages.length, timestamp });
        return sendJson(res, 200, {
          ok: true,
          hook,
          compactedCount: olderMessages.length,
          compactDigest,
          keptMessages: msgList.slice(-6),
          timestamp
        });
      }

      // 5. SubagentStart / SubagentStop / NotifyAgentTurnFinished
      broadcastEvent("agent_hook", { hook, botId, botName, branch: wt.branch, timestamp });
      return sendJson(res, 200, { ok: true, hook, botId, branch: wt.branch, timestamp });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 2F. Vanaras AgentStoreService & Sandbox Manifest Store (/api/agent/store)
  if (req.method === "POST" && req.url === "/api/agent/store") {
    try {
      const {
        action = "CommitSandBoxStoreManifest",
        botId = "bot_r1",
        botName = "R1",
        objectKey = "shared-spec.md",
        content = ""
      } = await readJsonBody(req);

      const storeDir = path.join(AGENTS_STATE_DIR, "agent-store");
      const locksFile = path.join(storeDir, "_locks.json");
      fs.mkdirSync(storeDir, { recursive: true });
      const locks = fs.existsSync(locksFile) ? JSON.parse(fs.readFileSync(locksFile, "utf8")) : {};

      if (action === "AcquireAgentStoreFileLock") {
        const currentLock = locks[objectKey];
        if (currentLock && currentLock.owner !== botId && (Date.now() - currentLock.acquiredAt) < 30000) {
          return sendJson(res, 200, { ok: false, lockedBy: currentLock.owner, objectKey });
        }
        locks[objectKey] = { owner: botId, botName, acquiredAt: Date.now() };
        fs.writeFileSync(locksFile, JSON.stringify(locks, null, 2), "utf8");
        return sendJson(res, 200, { ok: true, action, objectKey, owner: botId, locks });
      }

      if (action === "ReleaseAgentStoreFileLock") {
        delete locks[objectKey];
        fs.writeFileSync(locksFile, JSON.stringify(locks, null, 2), "utf8");
        return sendJson(res, 200, { ok: true, action, objectKey, locks });
      }

      if (action === "CommitSandBoxStoreManifest") {
        const wt = ensureAgentWorktree(botId, botName);
        const promotedToRoot = syncWorktreeDeliverablesToMainRoot(wt);
        const files = listAgentCodeFiles(wt.codeDir).map(f => ({
          name: f.name,
          size: f.size,
          updatedAt: f.updatedAt
        }));
        const manifest = {
          sandboxId: `vanara-box-${sanitizeSlug(botId)}`,
          botId,
          botName,
          branch: wt.branch,
          codeDir: wt.codeDir,
          committedAt: new Date().toISOString(),
          promotedToRoot,
          objects: files,
          locks
        };
        const manifestFile = path.join(storeDir, `${sanitizeSlug(botId)}-manifest.json`);
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
        return sendJson(res, 200, { ok: true, action, promotedToRoot, manifest });
      }

      if (action === "StatSandBoxStoreObject") {
        const wt = ensureAgentWorktree(botId, botName);
        const files = listAgentCodeFiles(wt.codeDir).map(f => ({ name: f.name, size: f.size, updatedAt: f.updatedAt }));
        return sendJson(res, 200, { ok: true, action, branch: wt.branch, objects: files, locks });
      }

      return sendJson(res, 200, { ok: true, action, locks });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 2G. Vanaras File-Watcher & Scheduled Heartbeat Daemon (/api/agent/watcher)
  if (req.method === "POST" && req.url === "/api/agent/watcher") {
    try {
      const {
        action = "status",
        botId = "bot_r1",
        botName = "R1",
        threadId = "thread_r1",
        intervalSec = 0
      } = await readJsonBody(req);

      const wt = ensureAgentWorktree(botId, botName);

      if (action === "start_watch") {
        if (agentWatchers.has(botId)) {
          try { agentWatchers.get(botId).close(); } catch {}
          agentWatchers.delete(botId);
        }
        let debounceTimer = null;
        const watcher = fs.watch(wt.codeDir, { recursive: true }, (eventType, filename) => {
          if (!filename || filename.startsWith(".")) return;
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            broadcastEvent("agent_heartbeat", {
              type: "file_change",
              trigger: "fs_watch",
              botId,
              botName,
              threadId,
              branch: wt.branch,
              filename,
              fileName: filename,
              eventType,
              timestamp: new Date().toISOString()
            });
          }, 900);
        });
        agentWatchers.set(botId, watcher);

        if (agentHeartbeats.has(botId)) {
          clearInterval(agentHeartbeats.get(botId));
          agentHeartbeats.delete(botId);
        }
        if (Number(intervalSec) >= 15) {
          const timer = setInterval(() => {
            broadcastEvent("agent_heartbeat", {
              type: "scheduled_heartbeat",
              trigger: "heartbeat",
              botId,
              botName,
              threadId,
              branch: wt.branch,
              intervalSec: Number(intervalSec),
              timestamp: new Date().toISOString()
            });
          }, Number(intervalSec) * 1000);
          agentHeartbeats.set(botId, timer);
        }

        return sendJson(res, 200, {
          ok: true,
          watching: true,
          botId,
          codeDir: wt.codeDir,
          intervalSec: Number(intervalSec) || 60,
          heartbeatSec: Number(intervalSec) || 60
        });
      }

      if (action === "stop_watch") {
        if (agentWatchers.has(botId)) {
          try { agentWatchers.get(botId).close(); } catch {}
          agentWatchers.delete(botId);
        }
        if (agentHeartbeats.has(botId)) {
          clearInterval(agentHeartbeats.get(botId));
          agentHeartbeats.delete(botId);
        }
        return sendJson(res, 200, { ok: true, watching: false, botId });
      }

      return sendJson(res, 200, {
        ok: true,
        watching: agentWatchers.has(botId),
        heartbeatActive: agentHeartbeats.has(botId),
        botId
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 2H. Vanaras Sandbox Lifecycle & Headless Web Verification (/api/agent/sandbox)
  if (req.method === "POST" && req.url === "/api/agent/sandbox") {
    try {
      const {
        action = "EnsureSandBox",
        botId = "bot_r1",
        botName = "R1",
        url = ""
      } = await readJsonBody(req);

      const wt = ensureAgentWorktree(botId, botName);

      if (action === "EnsureSandBox") {
        const snapshotRef = getHeadSha(wt.worktreePath);
        return sendJson(res, 200, {
          ok: true,
          action,
          sandboxId: `vanara-box-${sanitizeSlug(botId)}`,
          status: "ACTIVE",
          state: "ACTIVE",
          snapshotRef,
          branch: wt.branch,
          codeDir: wt.codeDir,
          assignedPort: getAgentAssignedPort(botId),
          files: listAgentCodeFiles(wt.codeDir)
        });
      }

      if (action === "HibernateSandBox") {
        const srv = agentDevServers.get(botId);
        if (srv && srv.proc && !srv.proc.killed) {
          killProcessTree(srv.proc);
        }
        agentDevServers.delete(botId);
        if (agentWatchers.has(botId)) {
          try { agentWatchers.get(botId).close(); } catch {}
          agentWatchers.delete(botId);
        }
        const snapshotRef = getHeadSha(wt.worktreePath);
        return sendJson(res, 200, {
          ok: true,
          action,
          sandboxId: `vanara-box-${sanitizeSlug(botId)}`,
          status: "HIBERNATED",
          state: "HIBERNATED",
          snapshotRef,
          branch: wt.branch
        });
      }

      if (action === "RecreateSandBox") {
        const srv = agentDevServers.get(botId);
        if (srv && srv.proc && !srv.proc.killed) {
          killProcessTree(srv.proc);
        }
        agentDevServers.delete(botId);
        fs.rmSync(wt.codeDir, { recursive: true, force: true });
        const freshWt = ensureAgentWorktree(botId, botName);
        const snapshotRef = getHeadSha(freshWt.worktreePath);
        return sendJson(res, 200, {
          ok: true,
          action,
          sandboxId: `vanara-box-${sanitizeSlug(botId)}`,
          status: "RECREATED",
          state: "RECREATED",
          snapshotRef,
          branch: freshWt.branch,
          codeDir: freshWt.codeDir,
          files: listAgentCodeFiles(freshWt.codeDir)
        });
      }

      if (action === "VerifyWebUrl") {
        const targetUrl = url || `http://localhost:${getAgentAssignedPort(botId)}`;
        const upstream = await fetch(targetUrl);
        const html = await upstream.text();
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const scriptCount = (html.match(/<script\b/gi) || []).length;
        const buttonCount = (html.match(/<button\b/gi) || []).length;
        return sendJson(res, 200, {
          ok: upstream.ok,
          action,
          url: targetUrl,
          status: upstream.status,
          title: titleMatch ? titleMatch[1].trim() : "(no <title>)",
          bytes: html.length,
          bodyBytes: html.length,
          scriptCount,
          buttonCount,
          snippet: html.replace(/\s+/g, " ").slice(0, 360)
        });
      }

      return sendJson(res, 400, { error: `Unknown sandbox action: ${action}` });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  return false;
}

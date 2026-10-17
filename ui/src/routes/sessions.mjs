// HTTP routes: /api/sessions/turn, /api/sessions/status, /api/sessions/stop, /api/sessions/checkpoints, /api/sessions/rewind, /api/sessions/compact, /api/approvals/list, /api/approvals/respond
import { execSync } from "node:child_process";
import { compactMessagesList } from "../context.mjs";
import { broadcastEvent } from "../events.mjs";
import { readJsonBody, sendJson } from "../http-utils.mjs";
import { stopTrackedProcess } from "../process.mjs";
import { executeServerSessionTurn } from "../session-runner.mjs";
import { activeApprovals, activeServerTurns, serverTurnKey, sessionCheckpoints } from "../state.mjs";
import { loadWorkspaceDiskState, saveWorkspaceDiskState } from "../workspace-state.mjs";
import { ensureAgentWorktree } from "../worktree.mjs";

// Liveness for the UI: a running turn with no progress for this long is reported as stalled, and a finished
// turn whose last message asks the user something is reported as waiting for them.
const STALL_AFTER_MS = 120000;
function turnLiveness(t) {
  const idleMs = t.status === "running" ? Math.max(0, Date.now() - Date.parse(t.updatedAt || t.startedAt)) : 0;
  const awaitingUser = t.status === "completed" && /\?\s*$/.test(String(t.finalContent || "").trim());
  return { idleMs, stalled: t.status === "running" && idleMs > STALL_AFTER_MS, awaitingUser };
}

export async function handleSessionsRoutes(req, res) {
  // 6C. Server-Side Autonomous Session Runner (POST /api/sessions/turn, GET /api/sessions/status, POST /api/sessions/stop)
  if (req.method === "POST" && req.url === "/api/sessions/turn") {
    try {
      const body = await readJsonBody(req);
      const { threadId, botId = "bot_r1", botName = "R1", prompt = "", systemPrompt = "", verifyCommand = "", maxSteps = 30, turnId = "" } = body;
      if (!prompt && !verifyCommand) {
        return sendJson(res, 400, { error: "prompt or verifyCommand required" });
      }
      const effectiveThreadId = threadId || `thread_${Date.now()}`;
      // A new message to an agent that is still working supersedes its running turn (the user moved on),
      // rather than being refused while the old turn keeps going unseen.
      const existing = activeServerTurns.get(serverTurnKey(effectiveThreadId, botId));
      if (existing && existing.status === "running") {
        existing.abortController?.abort();
        existing.status = "stopped";
        existing.message = "Superseded by a newer message";
      }

      executeServerSessionTurn({
        threadId: effectiveThreadId,
        botId,
        botName,
        prompt,
        systemPrompt,
        verifyCommand,
        maxSteps: Number(maxSteps) || 30,
        turnId: String(turnId || "")
      }).catch(err => {
        console.error("Unhandled error in executeServerSessionTurn:", err);
      });

      return sendJson(res, 200, {
        ok: true,
        threadId: effectiveThreadId,
        botId,
        turnId,
        status: "started"
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (req.method === "GET" && req.url.startsWith("/api/sessions/status")) {
    const qIndex = req.url.indexOf("?");
    const qParams = new URLSearchParams(qIndex >= 0 ? req.url.slice(qIndex) : "");
    const threadId = qParams.get("threadId");
    if (threadId) {
      const inThread = Array.from(activeServerTurns.values()).filter(t => t.threadId === threadId);
      const turn = inThread.find(t => t.status === "running") || inThread[inThread.length - 1];
      return sendJson(res, 200, {
        ok: true,
        active: turn ? turn.status === "running" : false,
        turn: turn ? { ...turn, ...turnLiveness(turn) } : null
      });
    }
    // Enough for a window that missed live events (suspended, reloaded, reconnecting) to catch up: the
    // current progress line while running, and the result once finished.
    const all = Array.from(activeServerTurns.values()).map(t => ({
      turnId: t.turnId,
      threadId: t.threadId,
      botId: t.botId,
      botName: t.botName,
      status: t.status,
      step: t.step,
      maxSteps: t.maxSteps,
      message: t.message,
      startedAt: t.startedAt,
      updatedAt: t.updatedAt,
      ...(t.status === "running" ? {} : {
        finalContent: t.finalContent,
        reasoning: t.reasoning,
        remembered: t.remembered || []
      }),
      ...turnLiveness(t)
    }));
    return sendJson(res, 200, { ok: true, activeCount: all.filter(t => t.status === "running").length, turns: all });
  }

  if (req.method === "POST" && req.url === "/api/sessions/stop") {
    try {
      const { threadId, botId, turnId } = await readJsonBody(req);
      let stoppedCount = 0;
      for (const turn of activeServerTurns.values()) {
        if (turn.status !== "running") continue;
        if (turnId && turn.turnId !== turnId) continue;
        if (threadId && turn.threadId !== threadId) continue;
        if (botId && turn.botId !== botId) continue;
        turn.abortController?.abort();
        turn.status = "stopped";
        stoppedCount++;
      }
      if (botId && !turnId) stopTrackedProcess(botId);
      return sendJson(res, 200, { ok: true, stopped: stoppedCount > 0, count: stoppedCount });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // P3: Session Checkpoints & Rewind Endpoints
  if (req.method === "GET" && req.url.startsWith("/api/sessions/checkpoints")) {
    const qIndex = req.url.indexOf("?");
    const qParams = new URLSearchParams(qIndex >= 0 ? req.url.slice(qIndex) : "");
    const threadId = qParams.get("threadId");
    if (!threadId) return sendJson(res, 400, { error: "threadId required" });
    const list = sessionCheckpoints.get(threadId) || [];
    return sendJson(res, 200, { ok: true, threadId, checkpoints: list });
  }

  if (req.method === "POST" && req.url === "/api/sessions/rewind") {
    try {
      const { threadId, checkpointId, botId = "bot_r1", botName = "R1" } = await readJsonBody(req);
      if (!threadId) return sendJson(res, 400, { error: "threadId required" });
      const chkList = sessionCheckpoints.get(threadId) || [];
      if (chkList.length === 0) {
        return sendJson(res, 404, { error: `No checkpoints recorded for thread ${threadId}` });
      }
      let targetChk = null;
      if (checkpointId) {
        targetChk = chkList.find(c => c.checkpointId === checkpointId);
      } else {
        targetChk = chkList.pop();
      }
      if (!targetChk) {
        return sendJson(res, 404, { error: `Checkpoint not found: ${checkpointId}` });
      }

      const wt = ensureAgentWorktree(targetChk.botId || botId, targetChk.botName || botName);
      let gitResetOut = "";
      if (targetChk.preTurnSha) {
        try {
          execSync(`git reset --hard ${targetChk.preTurnSha}`, { cwd: wt.worktreePath, stdio: "pipe", timeout: 10000 });
          execSync("git clean -fd", { cwd: wt.worktreePath, stdio: "pipe", timeout: 10000 });
          gitResetOut = `Reset worktree to ${targetChk.preTurnSha}`;
        } catch (err) {
          gitResetOut = `Git reset failed: ${err.message}`;
        }
      }

      let state = loadWorkspaceDiskState() || { threads: [] };
      let thread = (state.threads || []).find(t => t.id === threadId);
      let remainingCount = 0;
      if (thread && Array.isArray(thread.messages)) {
        if (typeof targetChk.messagesCount === "number" && targetChk.messagesCount >= 0) {
          thread.messages = thread.messages.slice(0, targetChk.messagesCount);
        } else if (thread.messages.length > 0) {
          thread.messages.pop();
        }
        remainingCount = thread.messages.length;
        saveWorkspaceDiskState(state);
      }

      broadcastEvent("session_rewound", {
        threadId,
        botId: targetChk.botId || botId,
        checkpointId: targetChk.checkpointId,
        headSha: targetChk.preTurnSha,
        remainingMessages: remainingCount
      });

      return sendJson(res, 200, {
        ok: true,
        threadId,
        checkpointId: targetChk.checkpointId,
        restoredSha: targetChk.preTurnSha,
        remainingMessages: remainingCount,
        gitResetOut
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // P3: Session Compaction Endpoint
  if (req.method === "POST" && req.url === "/api/sessions/compact") {
    try {
      const { threadId, maxRecent = 4 } = await readJsonBody(req);
      if (!threadId) return sendJson(res, 400, { error: "threadId required" });
      let state = loadWorkspaceDiskState() || { threads: [] };
      let thread = (state.threads || []).find(t => t.id === threadId);
      if (!thread) return sendJson(res, 404, { error: `Thread not found: ${threadId}` });

      const originalCount = (thread.messages || []).length;
      const resCompact = compactMessagesList(thread.messages || [], Number(maxRecent) || 4);
      if (resCompact.compacted) {
        thread.messages = resCompact.messages;
        saveWorkspaceDiskState(state);
        broadcastEvent("session_compacted", {
          threadId,
          originalCount,
          newCount: thread.messages.length,
          compactedTurnsCount: resCompact.compactedTurnsCount
        });
      }

      return sendJson(res, 200, {
        ok: true,
        threadId,
        compacted: resCompact.compacted,
        originalCount,
        newCount: (thread.messages || []).length,
        summary: resCompact.summary || "No compaction required"
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // P3: Command Approvals Endpoints (GET /api/approvals/list, POST /api/approvals/respond)
  if (req.method === "GET" && req.url === "/api/approvals/list") {
    const list = Array.from(activeApprovals.values()).map(({ resolve, ...rest }) => rest);
    return sendJson(res, 200, { ok: true, count: list.length, approvals: list });
  }

  if (req.method === "POST" && req.url === "/api/approvals/respond") {
    try {
      const { approvalId, decision = "allow" } = await readJsonBody(req);
      if (!approvalId) return sendJson(res, 400, { error: "approvalId required" });
      const appr = activeApprovals.get(approvalId);
      if (!appr) return sendJson(res, 404, { error: `Approval request not found: ${approvalId}` });

      const cleanDecision = decision === "deny" ? "deny" : "allow";
      appr.status = cleanDecision === "allow" ? "approved" : "denied";
      if (typeof appr.resolve === "function") {
        appr.resolve({ decision: cleanDecision });
      }
      activeApprovals.delete(approvalId);

      broadcastEvent("approval_resolved", {
        approvalId,
        threadId: appr.threadId,
        botId: appr.botId,
        decision: cleanDecision,
        command: appr.command
      });

      return sendJson(res, 200, { ok: true, approvalId, decision: cleanDecision });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  return false;
}

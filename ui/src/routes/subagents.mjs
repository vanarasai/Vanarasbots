// HTTP routes: /api/subagents/spawn, /api/subagents/list, /api/subagents/status, /api/subagents/stop
import { readJsonBody, sendJson, sendRouteError } from "../http-utils.mjs";
import { activeSubagents } from "../state.mjs";
import { projectFromRequest } from "../projects.mjs";
import { spawnSubagentAsync } from "../subagents.mjs";

export async function handleSubagentsRoutes(req, res) {
  // 6D-2. Subagent Endpoints (POST /api/subagents/spawn, GET /api/subagents/list, GET /api/subagents/status, POST /api/subagents/stop)
  if (req.method === "POST" && req.url === "/api/subagents/spawn") {
    try {
      const body = await readJsonBody(req);
      const { type = "general", role = "Subagent", prompt = "", leadBotId = "bot_r1", leadBotName = "R1", maxSteps } = body;
      if (!prompt) return sendJson(res, 400, { error: "prompt is required" });
      const sub = await spawnSubagentAsync({ type, role, prompt, leadBotId, leadBotName, maxSteps, projectPath: projectFromRequest(req, body) });
      return sendJson(res, 200, {
        ok: true,
        subagentId: sub.id,
        type: sub.type,
        role: sub.role,
        branch: sub.branch,
        status: sub.status
      });
    } catch (e) {
      return sendRouteError(res, e, 500);
    }
  }

  if (req.method === "GET" && req.url === "/api/subagents/list") {
    const list = Array.from(activeSubagents.values()).map(s => ({
      id: s.id,
      type: s.type,
      role: s.role,
      leadBotId: s.leadBotId,
      status: s.status,
      currentStep: s.currentStep,
      maxSteps: s.maxSteps,
      branch: s.branch,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      toolCallsCount: s.toolCalls.length,
      outputPreview: (s.output || "").slice(0, 200)
    }));
    return sendJson(res, 200, { ok: true, count: list.length, subagents: list });
  }

  if (req.method === "GET" && req.url.startsWith("/api/subagents/status")) {
    const qIndex = req.url.indexOf("?");
    const qParams = new URLSearchParams(qIndex >= 0 ? req.url.slice(qIndex) : "");
    const subagentId = qParams.get("subagentId");
    if (!subagentId) return sendJson(res, 400, { error: "subagentId parameter required" });
    const sub = activeSubagents.get(subagentId);
    if (!sub) return sendJson(res, 404, { error: `Subagent not found: ${subagentId}` });
    return sendJson(res, 200, {
      ok: true,
      subagent: {
        id: sub.id,
        type: sub.type,
        role: sub.role,
        prompt: sub.prompt,
        status: sub.status,
        currentStep: sub.currentStep,
        maxSteps: sub.maxSteps,
        branch: sub.branch,
        startedAt: sub.startedAt,
        updatedAt: sub.updatedAt,
        output: sub.output,
        reasoning: sub.reasoning,
        toolCalls: sub.toolCalls
      }
    });
  }

  if (req.method === "POST" && req.url === "/api/subagents/stop") {
    try {
      const reqBody = await readJsonBody(req);
      const { subagentId } = reqBody;
      if (!subagentId) return sendJson(res, 400, { error: "subagentId required" });
      const sub = activeSubagents.get(subagentId);
      if (!sub) return sendJson(res, 404, { error: `Subagent not found: ${subagentId}` });
      if (sub.status === "running") {
        sub.abortController?.abort();
        sub.status = "stopped";
      }
      return sendJson(res, 200, { ok: true, subagentId, status: sub.status });
    } catch (e) {
      return sendRouteError(res, e, 500);
    }
  }

  return false;
}

// HTTP routes: /api/panels/personas, /api/panels/run, /api/panels/status, /api/panels/stop
import { readJsonBody, sendJson } from "../http-utils.mjs";
import { generatePersonas, listPanelRuns, startPanelRun, stopPanels } from "../panels.mjs";

export async function handlePanelsRoutes(req, res) {
  if (req.method === "POST" && req.url === "/api/panels/personas") {
    try {
      const { brief = "", count = 5, modelBotId = "bot_r1" } = await readJsonBody(req);
      if (!String(brief).trim()) return sendJson(res, 400, { ok: false, error: "Describe the audience first" });
      const personas = await generatePersonas({ brief, count, modelBotId });
      return sendJson(res, 200, { ok: true, personas });
    } catch (e) {
      return sendJson(res, 502, { ok: false, error: e.message });
    }
  }

  if (req.method === "POST" && req.url === "/api/panels/run") {
    try {
      const body = await readJsonBody(req);
      const run = startPanelRun(body);
      return sendJson(res, 200, { ok: true, runId: run.runId, threadId: run.threadId, status: run.status });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (req.method === "GET" && req.url.startsWith("/api/panels/status")) {
    const q = new URLSearchParams(req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
    const runs = listPanelRuns({ threadId: q.get("threadId") || "", runId: q.get("runId") || "" });
    return sendJson(res, 200, { ok: true, runs });
  }

  if (req.method === "POST" && req.url === "/api/panels/stop") {
    try {
      const { threadId = "", runId = "" } = await readJsonBody(req);
      return sendJson(res, 200, { ok: true, stopped: stopPanels({ threadId, runId }) });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  return false;
}

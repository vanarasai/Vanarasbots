// HTTP routes: /api/projects/check, /api/projects/init — what a room's folder is, and (only when the user
// agrees) turning it into a git repository agents can branch from.
import { readJsonBody, sendJson, sendRouteError } from "../http-utils.mjs";
import { initProject, inspectProject } from "../projects.mjs";

export async function handleProjectsRoutes(req, res) {
  if (req.method === "POST" && req.url === "/api/projects/check") {
    try {
      const { path: folder = "" } = await readJsonBody(req);
      return sendJson(res, 200, inspectProject(folder));
    } catch (e) {
      return sendRouteError(res, e, 400);
    }
  }
  if (req.method === "POST" && req.url === "/api/projects/init") {
    try {
      const { path: folder = "", confirmed = false } = await readJsonBody(req);
      if (confirmed !== true) return sendJson(res, 400, { ok: false, error: "Initialising a folder needs the user's confirmation." });
      return sendJson(res, 200, initProject(folder));
    } catch (e) {
      return sendRouteError(res, e, 400);
    }
  }
  return false;
}

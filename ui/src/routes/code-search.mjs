// HTTP route: POST /api/code-search — hybrid search over an agent's worktree or the project folder.
import path from "node:path";
import { WORKTREES_DIR } from "../config.mjs";
import { codeSearch } from "../code-index.mjs";
import { readJsonBody, sendJson, sendRouteError } from "../http-utils.mjs";
import { isPathInside } from "../util.mjs";
import { ensureAgentWorktree } from "../worktree.mjs";

export async function handleCodeSearchRoutes(req, res) {
  if (req.method === "POST" && req.url === "/api/code-search") {
    try {
      const reqBody = await readJsonBody(req);
      const { query = "", botId = "", root = "", path: scope = "", limit = 8, budgetChars = 7000, semantic = true } = reqBody;
      // The agent's worktree of the room's project, else the project itself; a root must lie inside one.
      const projectRoot = projectFromRequest(req, reqBody);
      let base = projectRoot;
      if (botId) {
        base = ensureAgentWorktree(botId, botId.replace(/^bot_/, "").toUpperCase(), projectRoot).worktreePath;
      } else if (root) {
        base = path.resolve(String(root));
        const projectWorktrees = path.join(WORKTREES_DIR, projectKey(projectRoot));
        if (!isPathInside(base, projectRoot) && !isPathInside(base, projectWorktrees)) {
          return sendJson(res, 400, { ok: false, error: "root must be inside the room's project or its agents' worktrees" });
        }
      }
      const r = await codeSearch(base, query, { limit, pathPrefix: scope, budgetChars, semantic: semantic !== false });
      return sendJson(res, 200, { ok: true, root: base, ...r });
    } catch (e) {
      return sendRouteError(res, e, 400);
    }
  }
  return false;
}

// HTTP route: POST /api/code-search — hybrid search over an agent's worktree or the project folder.
import path from "node:path";
import { ROOT_DIR, WORKTREES_DIR } from "../config.mjs";
import { codeSearch } from "../code-index.mjs";
import { readJsonBody, sendJson } from "../http-utils.mjs";
import { isPathInside } from "../util.mjs";
import { ensureAgentWorktree } from "../worktree.mjs";

export async function handleCodeSearchRoutes(req, res) {
  if (req.method === "POST" && req.url === "/api/code-search") {
    try {
      const { query = "", botId = "", root = "", path: scope = "", limit = 8, budgetChars = 7000, semantic = true } = await readJsonBody(req);
      let base = ROOT_DIR;
      if (botId) {
        base = ensureAgentWorktree(botId, botId.replace(/^bot_/, "").toUpperCase()).worktreePath;
      } else if (root) {
        base = path.resolve(String(root));
        if (!isPathInside(base, ROOT_DIR) && !isPathInside(base, WORKTREES_DIR)) {
          return sendJson(res, 400, { ok: false, error: "root must be inside the project or an agent worktree" });
        }
      }
      const r = await codeSearch(base, query, { limit, pathPrefix: scope, budgetChars, semantic: semantic !== false });
      return sendJson(res, 200, { ok: true, root: base, ...r });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }
  return false;
}

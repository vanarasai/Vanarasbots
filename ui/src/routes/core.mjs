// HTTP routes: /api/health, /api/events, /api/workspace, /api/settings/keys
import { PORT, ROOT_DIR } from "../config.mjs";
import { broadcastEvent } from "../events.mjs";
import { readJsonBody, sendJson } from "../http-utils.mjs";
import { sseClients } from "../state.mjs";
import { loadLocalKeysVault, saveLocalKeysVault } from "../vault.mjs";
import { loadWorkspaceDiskState, saveWorkspaceDiskState } from "../workspace-state.mjs";

export async function handleCoreRoutes(req, res) {
  if (req.method === "GET" && (req.url === "/api/health" || req.url.startsWith("/api/health?"))) {
    return sendJson(res, 200, { ok: true, status: "running", pid: process.pid, port: PORT });
  }

  // 1. Real-time Multiplayer & Background Task Event Stream (SSE)
  if (req.method === "GET" && req.url.startsWith("/api/events")) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    res.write(`event: connected\ndata: {"status":"ok"}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // 2. Shared Disk-Backed Workspace State (GET & POST /api/workspace)
  if (req.method === "GET" && req.url === "/api/workspace") {
    const saved = loadWorkspaceDiskState();
    // No default project: every room chooses its own. vanarasRoot lets the UI recognise (and confirm) a room
    // that deliberately mounts Vanaras itself.
    return sendJson(res, 200, { state: saved, defaultMountPath: "", vanarasRoot: ROOT_DIR });
  }

  if (req.method === "POST" && req.url === "/api/workspace") {
    try {
      const { state } = await readJsonBody(req);
      if (state) {
        saveWorkspaceDiskState(state);
        broadcastEvent("workspace_synced", { updatedAt: Date.now() });
      }
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 2.1 Local Disk-Backed API Key Vault (GET & POST /api/settings/keys)
  if (req.method === "GET" && req.url === "/api/settings/keys") {
    const vault = loadLocalKeysVault();
    return sendJson(res, 200, { ok: true, providers: vault.providers || {}, bots: vault.bots || {}, updatedAt: vault.updatedAt || null });
  }

  if (req.method === "POST" && req.url === "/api/settings/keys") {
    try {
      const bodyObj = await readJsonBody(req);
      const saved = saveLocalKeysVault({
        providers: bodyObj.providers || {},
        bots: bodyObj.bots || {}
      });
      return sendJson(res, 200, { ok: true, providers: saved.providers || {}, bots: saved.bots || {}, updatedAt: saved.updatedAt });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  return false;
}

#!/usr/bin/env node
// Vanaras Desktop Engine entrypoint: loopback HTTP server, route dispatch, and process lifecycle.
import http from "node:http";
import { PORT } from "./src/config.mjs";
import { ensureAgentPortServerRunning } from "./src/port-supervisor.mjs";
import { signalProcessTree } from "./src/process.mjs";
import { enforceLocalRequestBoundary } from "./src/security.mjs";
import { activeRunProcs, activeServerTurns, activeSubagents, agentBackgroundProcesses, agentDevServers } from "./src/state.mjs";
import { syncAllWorktreesToMainRoot } from "./src/worktree.mjs";
import { handleCoreRoutes } from "./src/routes/core.mjs";
import { handleAgentWorkspaceRoutes } from "./src/routes/agent-workspace.mjs";
import { handleAgentConfigRoutes } from "./src/routes/agent-config.mjs";
import { handleAgentToolsRoutes } from "./src/routes/agent-tools.mjs";
import { handleAgentLifecycleRoutes } from "./src/routes/agent-lifecycle.mjs";
import { handleWorkspaceRunnerRoutes } from "./src/routes/workspace-runner.mjs";
import { handleLlmRoutes } from "./src/routes/llm.mjs";
import { handleSessionsRoutes } from "./src/routes/sessions.mjs";
import { handleSubagentsRoutes } from "./src/routes/subagents.mjs";
import { handleFilesRoutes } from "./src/routes/files.mjs";
import { handleStaticRoutes } from "./src/routes/static.mjs";

const ROUTE_HANDLERS = [
  handleCoreRoutes,
  handleAgentWorkspaceRoutes,
  handleAgentConfigRoutes,
  handleAgentToolsRoutes,
  handleAgentLifecycleRoutes,
  handleWorkspaceRunnerRoutes,
  handleLlmRoutes,
  handleSessionsRoutes,
  handleSubagentsRoutes,
  handleFilesRoutes,
  handleStaticRoutes
];

const server = http.createServer(async (req, res) => {
  if (!enforceLocalRequestBoundary(req, res)) return;

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Route groups are tried in order; a group returns false when none of its routes matched.
  for (const handler of ROUTE_HANDLERS) {
    if ((await handler(req, res)) !== false) return;
  }
});

// Owned command trees run in their own process groups, so they no longer receive the terminal's
// Ctrl+C. Terminate the trees this server tracks when it shuts down. Agent preview servers started
// by ensureAgentPortServerRunning are intentionally long-lived and are not tracked here.
function terminateOwnedProcessTrees() {
  for (const proc of activeRunProcs.values()) signalProcessTree(proc, "SIGTERM");
  for (const srv of agentDevServers.values()) if (srv && srv.proc) signalProcessTree(srv.proc, "SIGTERM");
  for (const bg of agentBackgroundProcesses.values()) if (bg && bg.child) signalProcessTree(bg.child, "SIGTERM");
  for (const turn of activeServerTurns.values()) if (turn && turn.status === "running") turn.abortController?.abort();
  for (const sub of activeSubagents.values()) if (sub && sub.status === "running") sub.abortController?.abort();
}

process.on("exit", terminateOwnedProcessTrees);

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(sig, () => {
    terminateOwnedProcessTrees();
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.log(`Vanaras Desktop Engine is already running on http://localhost:${PORT}`);
    process.exit(0);
  }
  console.error("Server error:", err);
});

// Loopback-only binding: the API executes shell commands, so it must never listen on LAN interfaces.
// 127.0.0.1 is primary (the macOS app health check and Vanaras.command use it). A second listener on
// ::1 serves clients that resolve "localhost" to IPv6 first; it shares the same request handler.
const LOOPBACK_V4 = "127.0.0.1";

const LOOPBACK_V6 = "::1";

function listenOnIpv6Loopback() {
  const v6 = http.createServer((req, res) => server.emit("request", req, res));
  v6.on("error", (err) => {
    // IPv6 may be disabled, or ::1 may already be held by an older instance. IPv4 loopback still works.
    console.warn(`IPv6 loopback listener unavailable (${err.code || err.message}); serving on ${LOOPBACK_V4} only`);
  });
  v6.listen(PORT, LOOPBACK_V6);
}

server.listen(PORT, LOOPBACK_V4, () => {
  listenOnIpv6Loopback();
  const promoted = syncAllWorktreesToMainRoot();
  ensureAgentPortServerRunning(3847, "bot_r1").catch(() => {});
  console.log(`Vanaras Desktop Engine listening at http://localhost:${PORT}${promoted.length > 0 ? ` (synced ${promoted.length} deliverables to main root)` : ""}`);
});

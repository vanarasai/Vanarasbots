// HTTP routes: /api/workspace/context, /api/workspace/kill, /api/workspace/exec, /api/room/post, /api/events/publish
import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "../util.mjs";
import { broadcastEvent } from "../events.mjs";
import { readJsonBody, sendJson, sendRouteError } from "../http-utils.mjs";
import { projectFromRequest } from "../projects.mjs";
import { spawnCommandAsync, stopTrackedProcess } from "../process.mjs";
import { inspectMountedDirectory } from "../repo-inspect.mjs";
import { activeRunProcs, backgroundJobs } from "../state.mjs";
import { ensureAgentWorktree } from "../worktree.mjs";

export async function handleWorkspaceRunnerRoutes(req, res) {
  // 3. Grounded Folder Inspection Endpoint (POST /api/workspace/context)
  if (req.method === "POST" && req.url === "/api/workspace/context") {
    try {
      const reqBody = await readJsonBody(req);
      const { mountPath, folderPath, botId, botName } = reqBody;
      let targetDir = mountPath || folderPath || projectFromRequest(req, reqBody);
      let codeDir = "";
      let worktreeInfo = null;
      if (botId) {
        const wt = ensureAgentWorktree(botId, botName, projectFromRequest(req, reqBody));
        targetDir = wt.worktreePath;
        codeDir = wt.codeDir;
        worktreeInfo = wt;
      }
      const info = inspectMountedDirectory(targetDir, codeDir);
      if (worktreeInfo) info.worktree = worktreeInfo;
      return sendJson(res, 200, info);
    } catch (e) {
      return sendRouteError(res, e, 500);
    }
  }

  // 4. Asynchronous Background Command / Tool Runner (POST /api/workspace/exec & /api/workspace/kill)
  if (req.method === "POST" && req.url === "/api/workspace/kill") {
    try {
      const reqBody = await readJsonBody(req);
      const { threadId, botId, botIds } = reqBody;
      const targetBotIds = new Set([
        ...(Array.isArray(botIds) ? botIds : []),
        ...(botId ? [botId] : [])
      ].map(String).filter(Boolean));
      const killedJobs = [];
      for (const [jobId, job] of backgroundJobs.entries()) {
        if (job.status !== "running") continue;
        const matchesThread = threadId && job.threadId === threadId;
        const matchesBot = job.botId && targetBotIds.has(String(job.botId));
        const killAll = !threadId && targetBotIds.size === 0;
        if (killAll || matchesThread || matchesBot) {
          stopTrackedProcess(activeRunProcs.get(jobId) || job.proc, "Command stopped by user");
          job.status = "killed";
          killedJobs.push(jobId);
        }
      }
      for (const id of targetBotIds) {
        if (activeRunProcs.has(id)) {
          stopTrackedProcess(activeRunProcs.get(id), "Stopped by user");
          activeRunProcs.delete(id);
          killedJobs.push(`run_${id}`);
        }
      }
      return sendJson(res, 200, { ok: true, killedCount: killedJobs.length, killedJobs });
    } catch (e) {
      return sendRouteError(res, e, 500);
    }
  }

  if (req.method === "POST" && req.url === "/api/workspace/exec") {
    try {
      const reqBody = await readJsonBody(req);
      const { command, cwd, threadId, botId, botName } = reqBody;
      if (!command) return sendJson(res, 400, { error: "Missing command" });

      // Commands run in the room's project (or the agent's worktree of it), never elsewhere.
      const projectRoot = projectFromRequest(req, reqBody);
      let targetCwd = cwd && fs.existsSync(cwd) && isPathInside(path.resolve(cwd), projectRoot) ? path.resolve(cwd) : projectRoot;
      let branch = "";
      if (botId) {
        const wt = ensureAgentWorktree(botId, botName || botId, projectFromRequest(req, reqBody));
        targetCwd = wt.worktreePath;
        branch = wt.branch;
      }

      const jobId = "job_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);

      broadcastEvent("job_started", { jobId, command, threadId, botId, botName, cwd: targetCwd, branch });
      backgroundJobs.set(jobId, { id: jobId, command, threadId, botId, botName, status: "running", startedAt: Date.now() });

      spawnCommandAsync(command, { cwd: targetCwd, worktreePath: targetCwd, timeout: 25000, trackKey: jobId })
        .then(execRes => {
          const output = String(execRes.output || "").trim().slice(0, 4000);
          const exitCode = execRes.exitCode;
          backgroundJobs.set(jobId, { id: jobId, command, threadId, botId, botName, status: "done", exitCode, output });
          broadcastEvent("job_finished", {
            jobId,
            command,
            cwd: targetCwd,
            branch,
            exitCode,
            output: output || (exitCode === 130 ? "(Command stopped by user)" : "(Command completed with no output)"),
            threadId,
            botId,
            botName
          });
          // Bound retained job history so long sessions do not grow the map without limit.
          if (backgroundJobs.size > 200) {
            for (const [id, job] of backgroundJobs) {
              if (job.status !== "running") backgroundJobs.delete(id);
              if (backgroundJobs.size <= 150) break;
            }
          }
        });

      return sendJson(res, 200, { jobId, status: "started", cwd: targetCwd, branch });
    } catch (e) {
      return sendRouteError(res, e, 500);
    }
  }

  // 5. External Human Peer / CLI System Agent Message Injection
  if (req.method === "POST" && (req.url === "/api/room/post" || req.url === "/api/events/publish")) {
    try {
      const msg = await readJsonBody(req);
      broadcastEvent("room_message", msg);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendRouteError(res, e, 400);
    }
  }

  return false;
}

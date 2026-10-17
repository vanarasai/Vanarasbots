// HTTP routes: /api/workspace/context, /api/workspace/kill, /api/workspace/exec, /api/room/post, /api/events/publish
import fs from "node:fs";
import { ROOT_DIR } from "../config.mjs";
import { broadcastEvent } from "../events.mjs";
import { readJsonBody, sendJson } from "../http-utils.mjs";
import { spawnCommandAsync, stopTrackedProcess } from "../process.mjs";
import { inspectMountedDirectory } from "../repo-inspect.mjs";
import { activeRunProcs, backgroundJobs } from "../state.mjs";
import { ensureAgentWorktree } from "../worktree.mjs";

export async function handleWorkspaceRunnerRoutes(req, res) {
  // 3. Grounded Folder Inspection Endpoint (POST /api/workspace/context)
  if (req.method === "POST" && req.url === "/api/workspace/context") {
    try {
      const { mountPath, folderPath, botId, botName } = await readJsonBody(req);
      let targetDir = mountPath || folderPath || ROOT_DIR;
      let codeDir = "";
      let worktreeInfo = null;
      if (botId) {
        const wt = ensureAgentWorktree(botId, botName);
        targetDir = wt.worktreePath;
        codeDir = wt.codeDir;
        worktreeInfo = wt;
      }
      const info = inspectMountedDirectory(targetDir, codeDir);
      if (worktreeInfo) info.worktree = worktreeInfo;
      return sendJson(res, 200, info);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 4. Asynchronous Background Command / Tool Runner (POST /api/workspace/exec & /api/workspace/kill)
  if (req.method === "POST" && req.url === "/api/workspace/kill") {
    try {
      const { threadId, botId, botIds } = await readJsonBody(req);
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
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (req.method === "POST" && req.url === "/api/workspace/exec") {
    try {
      const { command, cwd, threadId, botId, botName } = await readJsonBody(req);
      if (!command) return sendJson(res, 400, { error: "Missing command" });

      let targetCwd = cwd && fs.existsSync(cwd) ? cwd : ROOT_DIR;
      let branch = "main";
      if (botId) {
        const wt = ensureAgentWorktree(botId, botName || botId);
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
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 5. External Human Peer / CLI System Agent Message Injection
  if (req.method === "POST" && (req.url === "/api/room/post" || req.url === "/api/events/publish")) {
    try {
      const msg = await readJsonBody(req);
      broadcastEvent("room_message", msg);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  return false;
}

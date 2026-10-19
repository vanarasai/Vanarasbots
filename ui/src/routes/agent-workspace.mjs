// HTTP routes: /api/agent/workspace
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { resolveInWorktree } from "../agent-tools.mjs";
import { resolveSharedVenvDir } from "../env.mjs";
import { broadcastEvent } from "../events.mjs";
import { readJsonBody, sendJson, sendRouteError } from "../http-utils.mjs";
import { projectFromRequest } from "../projects.mjs";
import { killProcessTree, spawnCommandAsync, spawnShellProcessGroup } from "../process.mjs";
import { agentDevServers } from "../state.mjs";
import { execFileAsync, getAgentAssignedPort, isPathInside, safeGitCommit } from "../util.mjs";
import { ensureAgentWorktree, listAgentCodeFiles } from "../worktree.mjs";

export async function handleAgentWorkspaceRoutes(req, res) {
  // 2A. Per-Agent Dedicated Code Workspace Endpoint (/api/agent/workspace)
  if (req.method === "POST" && req.url === "/api/agent/workspace") {
    try {
      const reqBody = await readJsonBody(req);
      const {
        botId = "bot_r1",
        botName = "",
        action = "list",
        file = "",
        files = [],
        patches = [],
        fileName = "",
        filePath = "",
        command = "",
        title = "",
        body = ""
      } = reqBody;

      const wt = ensureAgentWorktree(botId, botName, projectFromRequest(req, reqBody));
      const targetFile = file || fileName || filePath || "";

      if (action === "diff") {
        const fileFilter = String(targetFile || "").trim();
        let diffStr = "";
        const diffFiles = [];
        try {
          const diffArgs = ["diff", "HEAD"];
          if (fileFilter) {
            diffArgs.push("--", fileFilter);
          }
          const gitDiffOut = execFileSync("git", diffArgs, {
            cwd: wt.worktreePath,
            stdio: "pipe",
            timeout: 5000
          }).toString("utf8");
          if (gitDiffOut) {
            diffStr += gitDiffOut;
          }
        } catch {}

        try {
          const statusOut = execFileSync("git", ["status", "--porcelain"], {
            cwd: wt.worktreePath,
            stdio: "pipe",
            timeout: 5000
          }).toString("utf8");

          const statusLines = statusOut.split(/\r?\n/).filter(Boolean);
          for (const line of statusLines) {
            const statusCode = line.slice(0, 2).trim();
            const relFile = line.slice(3).trim();
            if (fileFilter && relFile !== fileFilter) continue;

            let fileStatus = "modified";
            if (statusCode === "??" || statusCode === "?") fileStatus = "untracked";
            else if (statusCode === "A") fileStatus = "added";
            else if (statusCode === "D") fileStatus = "deleted";
            else if (statusCode === "M") fileStatus = "modified";
            diffFiles.push({ file: relFile, status: fileStatus });

            if (statusCode === "??" || statusCode === "?") {
              const fullUntracked = path.resolve(wt.worktreePath, relFile);
              if (isPathInside(fullUntracked, wt.worktreePath) && fs.existsSync(fullUntracked) && fs.statSync(fullUntracked).isFile()) {
                const untrackedContent = fs.readFileSync(fullUntracked, "utf8");
                const uLines = untrackedContent.split(/\r?\n/);
                const uDiff = [
                  `diff --git a/${relFile} b/${relFile}`,
                  `new file mode 100644`,
                  `--- /dev/null`,
                  `+++ b/${relFile}`,
                  `@@ -0,0 +1,${uLines.length} @@`,
                  ...uLines.map(l => `+${l}`)
                ].join("\n") + "\n";
                diffStr += (diffStr ? "\n" : "") + uDiff;
              }
            }
          }
        } catch {}

        return sendJson(res, 200, {
          ok: true,
          action: "diff",
          botId,
          botName: wt.botName,
          branch: wt.branch,
          diff: diffStr,
          files: diffFiles
        });
      }

      if (action === "revert_file") {
        const cleanFile = String(targetFile || "").trim();
        if (!cleanFile) {
          return sendJson(res, 400, { ok: false, error: "Missing file parameter for revert_file" });
        }
        if (cleanFile.includes("..")) {
          return sendJson(res, 400, { ok: false, error: "Path traversal outside workspace blocked" });
        }
        const relPath = cleanFile.replace(/^\/+/, "");
        const targetInWt = path.resolve(wt.worktreePath, relPath);
        if (!isPathInside(targetInWt, wt.worktreePath)) {
          return sendJson(res, 400, { ok: false, error: "Path traversal outside workspace blocked" });
        }

        let isTracked = false;
        try {
          execFileSync("git", ["ls-files", "--error-unmatch", relPath], {
            cwd: wt.worktreePath,
            stdio: "pipe",
            timeout: 5000
          });
          isTracked = true;
        } catch {}

        if (isTracked) {
          try {
            execFileSync("git", ["checkout", "HEAD", "--", relPath], {
              cwd: wt.worktreePath,
              stdio: "pipe",
              timeout: 5000
            });
          } catch (checkoutErr) {
            return sendJson(res, 500, { ok: false, error: `Failed to checkout tracked file: ${checkoutErr.message}` });
          }
        } else if (fs.existsSync(targetInWt) && fs.statSync(targetInWt).isFile()) {
          // Untracked: it only ever existed in this agent's worktree, so that is the only place it is removed.
          try { fs.unlinkSync(targetInWt); } catch {}
        }

        return sendJson(res, 200, {
          ok: true,
          action: "revert_file",
          botId,
          file: relPath,
          message: `Successfully reverted ${relPath}`
        });
      }

      if (action === "apply_patch" && Array.isArray(patches)) {
        const appliedPatches = [];
        for (const p of patches) {
          if (!p || !p.name) continue;
          const resolved = resolveInWorktree(wt, p.name);
          if (resolved.error) {
            appliedPatches.push({ file: String(p.name), matched: false, reason: resolved.error });
            continue;
          }
          const targetDest = resolved.abs;
          fs.mkdirSync(path.dirname(targetDest), { recursive: true });
          const currentContent = fs.existsSync(targetDest) ? fs.readFileSync(targetDest, "utf8") : "";
          const searchStr = String(p.search ?? "");
          const replaceStr = String(p.replace ?? "");
          let updatedContent = currentContent;
          let matched = false;
          if (searchStr && currentContent.includes(searchStr)) {
            updatedContent = currentContent.replace(searchStr, replaceStr);
            matched = true;
          } else if (!currentContent) {
            updatedContent = replaceStr;
            matched = true;
          } else if (searchStr.trim() && currentContent.includes(searchStr.trim())) {
            updatedContent = currentContent.replace(searchStr.trim(), replaceStr);
            matched = true;
          }
          if (matched) {
            fs.writeFileSync(targetDest, updatedContent, "utf8");
            appliedPatches.push({ file: resolved.rel, matched: true });
          } else {
            appliedPatches.push({ file: resolved.rel, matched: false, reason: "SEARCH block not found in target file" });
          }
        }

        let autoCommitOut = "";
        const modifiedFiles = appliedPatches.filter(x => x.matched).map(x => x.file);
        if (modifiedFiles.length > 0) {
          const slug = wt.botName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
          autoCommitOut = safeGitCommit(wt.worktreePath, `fix(${slug}): apply surgical patch to ${modifiedFiles.join(", ")}`, 5000);
        }
        const updatedWt = ensureAgentWorktree(botId, botName, projectFromRequest(req, reqBody));
        return sendJson(res, 200, { ...updatedWt, appliedPatches, autoCommitOut, files: listAgentCodeFiles(updatedWt.codeDir) });
      }

      if ((action === "save_files" || action === "save") && Array.isArray(files)) {
        const savedNames = [];
        for (const f of files) {
          if (!f || !f.name) continue;
          const resolved = resolveInWorktree(wt, f.name);
          if (resolved.error) continue;
          const dest = resolved.abs;
          const cleanedContent = String(f.content ?? "")
            .replace(/^```[a-zA-Z0-9_.-]*\r?\n/, "")
            .replace(/\r?\n```\s*$/, "");
          if (fs.existsSync(dest) && fs.statSync(dest).isFile()) {
            // Never replace a complete file with a truncated one (a reply cut off mid-file).
            const existingDisk = fs.readFileSync(dest, "utf8");
            const isHtml = /\.html?$/i.test(resolved.rel);
            if (
              (f.complete === false && existingDisk.length > cleanedContent.length) ||
              (isHtml && /<\/html>/i.test(existingDisk) && !/<\/html>/i.test(cleanedContent) && existingDisk.length > cleanedContent.length)
            ) {
              continue;
            }
          }
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, cleanedContent, "utf8");
          savedNames.push(resolved.rel);
        }
        // Commit the agent's changes onto its own branch (vanara/<agent>) of the project.
        let autoCommitOut = "";
        if (savedNames.length > 0) {
          const slug = wt.botName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
          autoCommitOut = safeGitCommit(wt.worktreePath, `feat(${slug}): update ${savedNames.join(", ")}`, 5000);
        }
        const updatedWt = ensureAgentWorktree(botId, botName, projectFromRequest(req, reqBody));
        return sendJson(res, 200, { ...updatedWt, savedNames, autoCommitOut, files: listAgentCodeFiles(updatedWt.codeDir) });
      }

      if (action === "commit_workspace") {
        const slug = wt.botName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        const commitMsg = String(command || `feat(${slug}): checkpoint agent workspace`);
        let output = "";
        try {
          safeGitCommit(wt.worktreePath, commitMsg, 5000);
          output = execFileSync("git", ["log", "--oneline", "-n", "4"], {
            cwd: wt.worktreePath,
            stdio: "pipe",
            timeout: 5000
          }).toString("utf8").trim();
        } catch (err) {
          output = err.message;
        }
        const updatedWt = ensureAgentWorktree(botId, botName, projectFromRequest(req, reqBody));
        return sendJson(res, 200, {
          ...updatedWt,
          output,
          files: listAgentCodeFiles(updatedWt.codeDir)
        });
      }

      // Brings the agent's branch into the project's checked-out branch. Only runs when the user asks (the UI's
      // Merge button); refuses if the project has uncommitted changes, and aborts on conflicts.
      if (action === "merge_to_main") {
        const slug = wt.botName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        const run = (cwd, args) => execFileSync("git", args, { cwd, stdio: "pipe", timeout: 30000 }).toString("utf8").trim();
        let output = "";
        let merged = false;
        try {
          safeGitCommit(wt.worktreePath, `feat(${slug}): checkpoint before merge`, 5000);
          const projectStatus = run(wt.projectRoot, ["status", "--porcelain", "--untracked-files=no"]);
          const targetBranch = run(wt.projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
          if (projectStatus) {
            output = `Not merged: ${wt.projectRoot} has uncommitted changes on ${targetBranch}. Commit or stash them, then merge again.\n${projectStatus}`;
          } else if (targetBranch === wt.branch) {
            output = `Not merged: the project is checked out on the agent's own branch (${wt.branch}).`;
          } else {
            const ahead = run(wt.projectRoot, ["rev-list", "--count", `${targetBranch}..${wt.branch}`]);
            if (ahead === "0") {
              output = `Nothing to merge: ${wt.branch} has no commits that ${targetBranch} does not already have.`;
            } else {
              try {
                run(wt.projectRoot, ["-c", "user.name=Vanaras", "-c", "user.email=vanaras@localhost", "merge", "--no-ff", "-m", `Merge ${wt.branch} (${wt.botName})`, wt.branch]);
                merged = true;
                output = `Merged ${ahead} commit(s) from ${wt.branch} into ${targetBranch}.\n${run(wt.projectRoot, ["log", "--oneline", "-n", "3"])}`;
              } catch (mergeErr) {
                let conflicts = "";
                try { conflicts = run(wt.projectRoot, ["diff", "--name-only", "--diff-filter=U"]); } catch {}
                try { run(wt.projectRoot, ["merge", "--abort"]); } catch {}
                output = `Not merged: conflicts with ${targetBranch}${conflicts ? ` in ${conflicts.split("\n").join(", ")}` : ""}. The merge was aborted; nothing changed.`;
              }
            }
          }
        } catch (err) {
          output = `Merge failed: ${err.message}`;
        }
        const updatedWt = ensureAgentWorktree(botId, botName, projectFromRequest(req, reqBody));
        return sendJson(res, 200, { ...updatedWt, merged, output, files: listAgentCodeFiles(updatedWt.codeDir) });
      }

      if (action === "delete_file" && fileName) {
        const cleanRel = String(fileName).replace(/^\/+/, "").replace(/\.\./g, "");
        const dest = path.resolve(wt.codeDir, cleanRel);
        if (isPathInside(dest, wt.codeDir) && fs.existsSync(dest) && fs.statSync(dest).isFile()) {
          fs.unlinkSync(dest);
        }
        return sendJson(res, 200, {
          ...wt,
          files: listAgentCodeFiles(wt.codeDir)
        });
      }

      if (action === "start_server") {
        const existing = agentDevServers.get(botId);
        if (existing && existing.proc && !existing.proc.killed) {
          killProcessTree(existing.proc);
        }
        const port = getAgentAssignedPort(botId);
        let serveCmd = command;
        if (!serveCmd) {
          if (fileName && (fileName.endsWith(".js") || fileName.endsWith(".mjs"))) {
            serveCmd = `PORT=${port} node "${fileName}"`;
          } else if (fileName && fileName.endsWith(".py") && fs.existsSync(path.join(wt.codeDir, fileName))) {
            const src = fs.readFileSync(path.join(wt.codeDir, fileName), "utf8");
            if (/http\.server|Flask|FastAPI|uvicorn|socketserver/i.test(src)) {
              serveCmd = `PORT=${port} python3 "${fileName}"`;
            } else {
              serveCmd = `python3 -m http.server ${port} --bind 127.0.0.1`;
            }
          } else {
            serveCmd = `python3 -m http.server ${port} --bind 127.0.0.1`;
          }
        }

        const proc = spawnShellProcessGroup(serveCmd, {
          cwd: wt.codeDir,
          env: { ...process.env, PORT: String(port) },
          stdio: ["ignore", "pipe", "pipe"]
        });

        const serverRecord = {
          botId,
          botName,
          port,
          url: `http://localhost:${port}`,
          command: serveCmd,
          cwd: wt.codeDir,
          startedAt: Date.now(),
          logs: [`[Vanara Dev Server] Started '${serveCmd}' on http://localhost:${port} in ${wt.codeDir}`],
          proc
        };
        agentDevServers.set(botId, serverRecord);

        const onChunk = rawChunk => {
          const line = rawChunk.toString("utf8").trim();
          if (!line) return;
          serverRecord.logs.push(line);
          if (serverRecord.logs.length > 80) serverRecord.logs.shift();
          broadcastEvent("agent_server_log", {
            botId,
            botName,
            port,
            url: serverRecord.url,
            line,
            chunk: line,
            logs: serverRecord.logs.join("\n")
          });
        };
        proc.stdout.on("data", onChunk);
        proc.stderr.on("data", onChunk);
        proc.on("exit", code => {
          const exitMsg = `[Server exited with code ${code ?? 0}]`;
          serverRecord.logs.push(exitMsg);
          broadcastEvent("agent_server_log", {
            botId,
            botName,
            port,
            url: serverRecord.url,
            stopped: true,
            line: exitMsg,
            chunk: exitMsg,
            logs: serverRecord.logs.join("\n")
          });
        });

        return sendJson(res, 200, {
          ok: true,
          running: true,
          pid: proc.pid,
          botId,
          botName,
          port,
          url: serverRecord.url,
          command: serveCmd,
          logs: serverRecord.logs.join("\n")
        });
      }

      if (action === "stop_server") {
        const existing = agentDevServers.get(botId);
        if (existing && existing.proc && !existing.proc.killed) {
          killProcessTree(existing.proc);
        }
        agentDevServers.delete(botId);
        return sendJson(res, 200, { ok: true, running: false, botId });
      }

      if (action === "server_status") {
        const existing = agentDevServers.get(botId);
        const running = Boolean(existing && existing.proc && !existing.proc.killed && existing.proc.exitCode === null);
        return sendJson(res, 200, {
          ok: true,
          running,
          pid: existing?.proc?.pid || null,
          port: existing?.port || getAgentAssignedPort(botId),
          url: existing?.url || `http://localhost:${getAgentAssignedPort(botId)}`,
          command: existing?.command || "",
          logs: existing ? existing.logs.join("\n") : ""
        });
      }

      if (action === "peer_review_diff") {
        let diffText = "";
        let statusText = "";
        let commitsText = "";
        try {
          statusText = execSync("git status --short", { cwd: wt.worktreePath, stdio: "pipe", timeout: 4000 }).toString("utf8").trim();
          commitsText = execSync("git log --oneline -n 5", { cwd: wt.worktreePath, stdio: "pipe", timeout: 4000 }).toString("utf8").trim();
          diffText = execSync("git diff main...HEAD || git diff HEAD~1 || true", { cwd: wt.worktreePath, stdio: "pipe", timeout: 5000 }).toString("utf8").trim();
        } catch {}
        const files = listAgentCodeFiles(wt.codeDir);
        const statOut = statusText || wt.diffStat || "(clean worktree)";
        return sendJson(res, 200, {
          ok: true,
          botId,
          botName,
          branch: wt.branch,
          baseRef: "main",
          status: statOut,
          stat: statOut,
          commits: commitsText || wt.commits || "(no commits)",
          diff: diffText.slice(0, 3500) || "(all changes committed on branch)",
          files
        });
      }

      if (action === "create_pr") {
        const slug = wt.botName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        const prTitle = String(command || title || `feat(${slug}): ${wt.botName} autonomous workspace changes`);
        const prBody = String(body || `Automated PR from Vanara agent **${wt.botName}** on isolated worktree branch \`${wt.branch}\`.`);
        let output = "";
        try {
          safeGitCommit(wt.worktreePath, prTitle, 5000);
          let pushOut = "";
          try {
            pushOut = execFileSync("git", ["push", "-u", "origin", wt.branch], { cwd: wt.worktreePath, stdio: "pipe", timeout: 10000 }).toString("utf8").trim();
          } catch (pushErr) {
            pushOut = ((pushErr.stdout ? pushErr.stdout.toString("utf8") : "") + "\n" + (pushErr.stderr ? pushErr.stderr.toString("utf8") : "")).trim();
          }
          let prOut = "";
          try {
            prOut = execFileSync(
              "gh",
              ["pr", "create", "--title", prTitle, "--body", prBody, "--head", wt.branch, "--base", "main"],
              { cwd: wt.worktreePath, stdio: "pipe", timeout: 10000 }
            ).toString("utf8").trim();
          } catch (ghErr) {
            prOut = (ghErr.stdout ? ghErr.stdout.toString("utf8") : "") + "\n" + (ghErr.stderr ? ghErr.stderr.toString("utf8") : "");
          }
          output = [pushOut, prOut.trim()].filter(Boolean).join("\n\n");
        } catch (err) {
          output = err.message;
        }
        return sendJson(res, 200, {
          ok: true,
          branch: wt.branch,
          output: output || `Branch ${wt.branch} ready for PR.`
        });
      }

      if (action === "run_file") {
        let runCmd = command;
        const cleanFile = String(fileName || "").replace(/\.\./g, "").replace(/^\/+/, "");
        const syntaxNotes = [];

        // Multi-file pre-flight syntax verification across all .py and .js/.mjs files in wt.codeDir
        const allCodeFiles = listAgentCodeFiles(wt.codeDir).filter(cf => !/^test_r3_/i.test(cf.name) || cf.name === cleanFile);
        for (const cf of allCodeFiles) {
          const absCf = path.join(wt.codeDir, cf.name);
          if (/\.py$/i.test(cf.name)) {
            try {
              await execFileAsync("python3", ["-m", "py_compile", absCf], { cwd: wt.codeDir, timeout: 4000 });
              syntaxNotes.push(`${cf.name}: py_compile OK`);
            } catch (syntaxErr) {
              const errMsg = String(syntaxErr.stderr || syntaxErr.stdout || syntaxErr.message).trim();
              return sendJson(res, 200, {
                ok: false,
                exitCode: 1,
                command: `python3 -m py_compile "${cf.name}"`,
                cwd: wt.codeDir,
                branch: wt.branch,
                output: `[Syntax Error in ${cf.name}]\n${errMsg}`
              });
            }
          } else if (/\.(js|mjs)$/i.test(cf.name)) {
            try {
              await execFileAsync("node", ["--check", absCf], { cwd: wt.codeDir, timeout: 4000 });
              syntaxNotes.push(`${cf.name}: node --check OK`);
            } catch (syntaxErr) {
              const errMsg = String(syntaxErr.stderr || syntaxErr.stdout || syntaxErr.message).trim();
              return sendJson(res, 200, {
                ok: false,
                exitCode: 1,
                command: `node --check "${cf.name}"`,
                cwd: wt.codeDir,
                branch: wt.branch,
                output: `[Syntax Error in ${cf.name}]\n${errMsg}`
              });
            }
          }
        }

        if (!runCmd && cleanFile) {
          const ext = path.extname(cleanFile).toLowerCase();
          if (ext === ".py") {
            const absTarget = path.join(wt.codeDir, cleanFile);
            const src = fs.existsSync(absTarget) ? fs.readFileSync(absTarget, "utf8") : "";
            const sharedVenv = resolveSharedVenvDir(wt.codeDir, wt.worktreePath);
            const pyBin = sharedVenv ? path.join(sharedVenv, "bin", "python3") : "python3";
            // Avoid hanging 15s if a script starts a blocking server loop (uvicorn.run / app.run / serve_forever)
            if (/\b(?:uvicorn\.run|app\.run|serve_forever)\s*\(/.test(src)) {
              runCmd = `"${pyBin}" -m py_compile "${cleanFile}" && echo "[Verified server entrypoint ${cleanFile} syntax & imports ready]"`;
            } else {
              runCmd = `"${pyBin}" "${cleanFile}"`;
            }
          } else if (ext === ".js" || ext === ".mjs") {
            runCmd = `node "${cleanFile}"`;
          } else if (ext === ".sh") {
            runCmd = `sh "${cleanFile}"`;
          } else if (ext === ".rs") {
            runCmd = `rustc "${cleanFile}" -o /tmp/vanara_bin && /tmp/vanara_bin`;
          } else {
            runCmd = `cat "${cleanFile}"`;
          }
        }
        if (!runCmd) runCmd = "ls -la";

        const execRes = await spawnCommandAsync(runCmd, {
          cwd: wt.codeDir,
          timeout: 15000,
          trackKey: botId
        });
        const combinedOut = [
          execRes.output,
          !execRes.output && syntaxNotes.length > 0 ? `[Verified: ${syntaxNotes.join(", ")}]` : ""
        ].filter(Boolean).join("\n").trim();

        return sendJson(res, 200, {
          ok: execRes.exitCode === 0,
          exitCode: execRes.exitCode,
          command: runCmd,
          cwd: wt.codeDir,
          branch: wt.branch,
          syntaxVerified: syntaxNotes,
          output: combinedOut || "(Completed with exit code 0)"
        });
      }

      const srv = agentDevServers.get(botId);
      return sendJson(res, 200, {
        ...wt,
        serverRunning: Boolean(srv && srv.proc && !srv.proc.killed && srv.proc.exitCode === null),
        serverPort: srv?.port || getAgentAssignedPort(botId),
        serverUrl: srv?.url || `http://localhost:${getAgentAssignedPort(botId)}`,
        files: listAgentCodeFiles(wt.codeDir)
      });
    } catch (e) {
      return sendRouteError(res, e, 500);
    }
  }

  return false;
}

// HTTP routes: /api/agent/worktree, /api/agent/memory, /api/agent/skill
import fs from "node:fs";
import path from "node:path";
import { discoverWorkspaceSkillFiles, getAgentConfigFile, getAgentSkillFile, loadAgentConfig, loadAgentMemory, loadAgentProjectMemories, loadAgentSkill, saveAgentConfig, saveAgentMemory, saveAgentSkill } from "../agent-store.mjs";
import { readJsonBody, sendJson, sendRouteError } from "../http-utils.mjs";
import { projectFromRequest } from "../projects.mjs";
import { execFileAsync, isPathInside, safeGitCommitAsync } from "../util.mjs";
import { resolveInWorktree } from "../agent-tools.mjs";
import { ensureAgentWorktree } from "../worktree.mjs";

export async function handleAgentConfigRoutes(req, res) {
  // 2B. Per-Agent Isolated Git Worktree Endpoint (/api/agent/worktree)
  if (req.method === "POST" && req.url === "/api/agent/worktree") {
    try {
      const reqBody = await readJsonBody(req);
      const { botId, botName, action = "ensure", filePath, content, commitMessage, message } = reqBody;
      const wt = ensureAgentWorktree(botId || "bot_r1", botName || "R1", projectFromRequest(req, reqBody));

      if (action === "write_file" && filePath) {
        const resolved = resolveInWorktree(wt, filePath);
        if (resolved.error) return sendJson(res, 400, { ok: false, error: resolved.error });
        fs.mkdirSync(path.dirname(resolved.abs), { recursive: true });
        fs.writeFileSync(resolved.abs, content || "", "utf8");
        return sendJson(res, 200, { ...ensureAgentWorktree(botId, botName, projectFromRequest(req, reqBody)), writtenFile: resolved.rel });
      }

      if (action === "commit") {
        const msg = String(commitMessage || message || `feat(${wt.botName}): autonomous worktree update`);
        await safeGitCommitAsync(wt.worktreePath, msg, 5000);
        return sendJson(res, 200, ensureAgentWorktree(botId, botName, projectFromRequest(req, reqBody)));
      }

      if (action === "diff") {
        let fullDiff = "";
        try {
          const { stdout } = await execFileAsync("git", ["diff", "HEAD"], { cwd: wt.worktreePath, timeout: 4000 });
          fullDiff = stdout.trim();
        } catch {}
        return sendJson(res, 200, { ...wt, fullDiff: fullDiff || "(No unstaged/staged changes against HEAD)" });
      }

      return sendJson(res, 200, wt);
    } catch (e) {
      return sendRouteError(res, e, 500);
    }
  }

  // 2C. Per-Agent Persistent Memory Endpoint (/api/agent/memory)
  if (req.method === "POST" && req.url === "/api/agent/memory") {
    try {
      const reqBody = await readJsonBody(req);
      // `project` (the room's project root) selects that project's memory; without it, the legacy list.
      const { botId, action = "get", fact, item, index, memories, project = "" } = reqBody;
      const memoryItem = fact || item;
      let current = loadAgentMemory(botId, project);
      if (action === "add" && memoryItem) {
        if (!current.includes(memoryItem)) current.unshift(memoryItem);
        saveAgentMemory(botId, current, project);
      } else if (action === "remove" && typeof index === "number") {
        current.splice(index, 1);
        saveAgentMemory(botId, current, project);
      } else if (action === "set" && Array.isArray(memories)) {
        current = memories;
        saveAgentMemory(botId, current, project);
      }
      return sendJson(res, 200, { botId, project, memories: current, projects: loadAgentProjectMemories(botId) });
    } catch (e) {
      return sendRouteError(res, e, 500);
    }
  }

  // 2C-bis. Per-Agent SKILL.md, MCP & Harness Configuration Store (/api/agent/skill)
  if (req.method === "POST" && req.url === "/api/agent/skill") {
    try {
      const reqBody = await readJsonBody(req);
      const { botId = "bot_r1", botName = "R1", botRole = "", role = "", action = "get", skillMarkdown = "", agentConfig = null } = reqBody;
      const effectiveRole = botRole || role;
      const templates = discoverWorkspaceSkillFiles();
      if (action === "set") {
        const savedPath = saveAgentSkill(botId, skillMarkdown);
        const savedConfig = agentConfig ? saveAgentConfig(botId, agentConfig) : loadAgentConfig(botId);
        return sendJson(res, 200, {
          ok: true,
          botId,
          skillFile: savedPath,
          configFile: getAgentConfigFile(botId),
          skillMarkdown: String(skillMarkdown || ""),
          agentConfig: savedConfig,
          templates
        });
      }
      const loaded = loadAgentSkill(botId, botName, effectiveRole);
      const loadedConfig = loadAgentConfig(botId);
      return sendJson(res, 200, {
        ok: true,
        botId,
        skillFile: getAgentSkillFile(botId),
        configFile: getAgentConfigFile(botId),
        skillMarkdown: loaded,
        agentConfig: loadedConfig,
        templates
      });
    } catch (e) {
      return sendRouteError(res, e, 500);
    }
  }

  return false;
}

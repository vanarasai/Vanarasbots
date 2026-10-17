// HTTP routes: /api/agent/worktree, /api/agent/memory, /api/agent/skill
import fs from "node:fs";
import path from "node:path";
import { discoverWorkspaceSkillFiles, getAgentConfigFile, getAgentSkillFile, loadAgentConfig, loadAgentMemory, loadAgentSkill, saveAgentConfig, saveAgentMemory, saveAgentSkill } from "../agent-store.mjs";
import { readJsonBody, sendJson } from "../http-utils.mjs";
import { execFileAsync, isPathInside, safeGitCommitAsync } from "../util.mjs";
import { ensureAgentWorktree, syncWorktreeDeliverablesToMainRoot } from "../worktree.mjs";

export async function handleAgentConfigRoutes(req, res) {
  // 2B. Per-Agent Isolated Git Worktree Endpoint (/api/agent/worktree)
  if (req.method === "POST" && req.url === "/api/agent/worktree") {
    try {
      const { botId, botName, customWorkspacePath = "", action = "ensure", filePath, content, commitMessage, message } = await readJsonBody(req);
      const wt = ensureAgentWorktree(botId || "bot_r1", botName || "R1", customWorkspacePath);

      if (action === "write_file" && filePath) {
        const cleanRel = filePath.replace(/^\/+/, "").replace(/\.\./g, "");
        const absTarget = path.resolve(wt.codeDir, cleanRel);
        if (isPathInside(absTarget, wt.codeDir)) {
          fs.mkdirSync(path.dirname(absTarget), { recursive: true });
          fs.writeFileSync(absTarget, content || "", "utf8");
          syncWorktreeDeliverablesToMainRoot(wt);
        }
        return sendJson(res, 200, { ...ensureAgentWorktree(botId, botName, customWorkspacePath), writtenFile: cleanRel });
      }

      if (action === "commit") {
        const msg = String(commitMessage || message || `feat(${wt.botName}): autonomous worktree update`);
        await safeGitCommitAsync(wt.worktreePath, msg, 5000);
        return sendJson(res, 200, ensureAgentWorktree(botId, botName, customWorkspacePath));
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
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 2C. Per-Agent Persistent Memory Endpoint (/api/agent/memory)
  if (req.method === "POST" && req.url === "/api/agent/memory") {
    try {
      const { botId, action = "get", fact, item, index, memories } = await readJsonBody(req);
      const memoryItem = fact || item;
      let current = loadAgentMemory(botId);
      if (action === "add" && memoryItem) {
        if (!current.includes(memoryItem)) current.unshift(memoryItem);
        saveAgentMemory(botId, current);
      } else if (action === "remove" && typeof index === "number") {
        current.splice(index, 1);
        saveAgentMemory(botId, current);
      } else if (action === "set" && Array.isArray(memories)) {
        current = memories;
        saveAgentMemory(botId, current);
      }
      return sendJson(res, 200, { botId, memories: current });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 2C-bis. Per-Agent SKILL.md, MCP & Harness Configuration Store (/api/agent/skill)
  if (req.method === "POST" && req.url === "/api/agent/skill") {
    try {
      const { botId = "bot_r1", botName = "R1", botRole = "", role = "", action = "get", skillMarkdown = "", agentConfig = null } = await readJsonBody(req);
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
      return sendJson(res, 500, { error: e.message });
    }
  }

  return false;
}

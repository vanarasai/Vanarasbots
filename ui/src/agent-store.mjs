// Per-agent memory, SKILL.md, and harness configuration persistence.
import fs from "node:fs";
import path from "node:path";
import { AGENTS_STATE_DIR, REPO_ROOT, ROOT_DIR } from "./config.mjs";
import { sanitizeSlug } from "./util.mjs";

// ============================================================================
// PER-AGENT PERSISTENT MEMORY STORE (.vanaras-agents/<botId>/memory.json)
// ============================================================================
export function getAgentMemoryFile(botId) {
  const slug = sanitizeSlug(botId, "bot");
  const dir = path.join(AGENTS_STATE_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "memory.json");
}

export function loadAgentMemory(botId) {
  try {
    const file = getAgentMemoryFile(botId);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(parsed.memories)) return parsed.memories;
    }
  } catch {}
  return [];
}

export function saveAgentMemory(botId, memories) {
  try {
    const file = getAgentMemoryFile(botId);
    fs.writeFileSync(file, JSON.stringify({ botId, updatedAt: Date.now(), memories }, null, 2), "utf8");
  } catch {}
}

export function getAgentSkillFile(botId) {
  const slug = sanitizeSlug(botId, "bot");
  const dir = path.join(AGENTS_STATE_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "SKILL.md");
}

export function defaultAgentSkillMarkdown(botId = "bot_r1", botName = "R1", role = "Systems Architect") {
  return `---
name: ${sanitizeSlug(botName || botId)}-skill
description: Operational SKILL.md playbook and domain standards for @${botName} (${role})
---

# @${botName} (${role}) — Agent Skill Playbook

## Core Responsibilities
- Deliver complete, runnable, syntax-verified code inside isolated worktree \`vanara/${sanitizeSlug(botName || botId)}\`.
- Never emit placeholder stubs, empty pass blocks, or synthetic test-tones when real synthesis is required.
- Use \`===FILE: <path>===\` for complete modules and \`===PATCH: <path>===\` for surgical edits.
`;
}

export function loadAgentSkill(botId, botName = "", role = "") {
  try {
    const file = getAgentSkillFile(botId);
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, "utf8");
    }
    const seed = defaultAgentSkillMarkdown(botId, botName || botId.replace(/^bot_/, "").toUpperCase(), role);
    fs.writeFileSync(file, seed, "utf8");
    return seed;
  } catch {
    return "";
  }
}

export function saveAgentSkill(botId, skillMarkdown = "") {
  try {
    const file = getAgentSkillFile(botId);
    fs.writeFileSync(file, String(skillMarkdown || ""), "utf8");
    return file;
  } catch {
    return "";
  }
}

export function getAgentConfigFile(botId) {
  const slug = sanitizeSlug(botId, "bot");
  const dir = path.join(AGENTS_STATE_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "agent-config.json");
}

export function loadAgentConfig(botId) {
  try {
    const file = getAgentConfigFile(botId);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {}
  return null;
}

export function saveAgentConfig(botId, config = {}) {
  try {
    const file = getAgentConfigFile(botId);
    const prev = loadAgentConfig(botId) || {};
    const merged = { ...prev, ...config, botId, updatedAt: Date.now() };
    fs.writeFileSync(file, JSON.stringify(merged, null, 2), "utf8");
    return merged;
  } catch {
    return null;
  }
}

export function discoverWorkspaceSkillFiles() {
  const found = [];
  const candidateRoots = [
    path.join(ROOT_DIR, ".agents", "skills"),
    path.join(ROOT_DIR, "skills"),
    path.join(REPO_ROOT, ".agents", "skills"),
    path.join(REPO_ROOT, "skills")
  ];
  const seenPaths = new Set();
  for (const base of candidateRoots) {
    if (!fs.existsSync(base)) continue;
    try {
      for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
        const skillPath = path.join(base, ent.name, "SKILL.md");
        if (fs.existsSync(skillPath) && !seenPaths.has(skillPath)) {
          seenPaths.add(skillPath);
          const content = fs.readFileSync(skillPath, "utf8").slice(0, 12000);
          found.push({
            id: ent.name,
            name: ent.name,
            path: skillPath,
            content
          });
        }
      }
    } catch {}
  }
  return found;
}

// Disk-backed shared workspace state.
import fs from "node:fs";
import { saveAgentMemory, saveAgentProjectMemories } from "./agent-store.mjs";
import { WORKSPACE_FILE } from "./config.mjs";
import { loadLocalKeysVault, saveLocalKeysVault } from "./vault.mjs";

export function loadWorkspaceDiskState() {
  try {
    if (fs.existsSync(WORKSPACE_FILE)) {
      const state = JSON.parse(fs.readFileSync(WORKSPACE_FILE, "utf8"));
      const vault = loadLocalKeysVault();
      if (state && Array.isArray(state.bots)) {
        state.bots.forEach(b => {
          if (!b.apiKey) {
            const restoredKey = (vault.bots && vault.bots[b.id]) || (vault.providers && vault.providers[b.provider]) || "";
            if (restoredKey) b.apiKey = restoredKey;
          }
        });
      }
      return state;
    }
  } catch (e) {
    console.warn("Could not read workspace file:", e.message);
  }
  return null;
}

export function saveWorkspaceDiskState(state) {
  try {
    const sanitized = JSON.parse(JSON.stringify(state));
    const botKeys = {};
    const providerKeys = {};
    if (Array.isArray(sanitized.bots)) {
      sanitized.bots.forEach(b => {
        if (b.apiKey && String(b.apiKey).trim()) {
          const cleanKey = String(b.apiKey).trim();
          botKeys[b.id] = cleanKey;
          if (b.provider && b.provider !== "local") {
            providerKeys[String(b.provider).toLowerCase()] = cleanKey;
          }
        }
        delete b.apiKey;
        if (Array.isArray(b.memories)) {
          saveAgentMemory(b.id, b.memories);
        }
        if (b.projectMemories && typeof b.projectMemories === "object") {
          saveAgentProjectMemories(b.id, b.projectMemories);
        }
      });
    }
    if (Object.keys(botKeys).length > 0 || Object.keys(providerKeys).length > 0) {
      saveLocalKeysVault({ providers: providerKeys, bots: botKeys });
    }
    fs.writeFileSync(WORKSPACE_FILE, JSON.stringify(sanitized, null, 2), "utf8");
  } catch (e) {
    console.warn("Could not write workspace file:", e.message);
  }
}

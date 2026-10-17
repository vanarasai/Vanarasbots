// Local API-key vault.
import fs from "node:fs";
import { KEYS_VAULT_FILE } from "./config.mjs";

export function loadLocalKeysVault() {
  try {
    if (fs.existsSync(KEYS_VAULT_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(KEYS_VAULT_FILE, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch (e) {
    console.warn("Could not read local keys vault:", e.message);
  }
  return { providers: {}, bots: {} };
}

export function saveLocalKeysVault(vaultUpdate = {}) {
  try {
    const current = loadLocalKeysVault();
    const merged = {
      providers: { ...(current.providers || {}), ...(vaultUpdate.providers || {}) },
      bots: { ...(current.bots || {}), ...(vaultUpdate.bots || {}) },
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(KEYS_VAULT_FILE, JSON.stringify(merged, null, 2), { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(KEYS_VAULT_FILE, 0o600); } catch {}
    return merged;
  } catch (e) {
    console.warn("Could not write local keys vault:", e.message);
    return loadLocalKeysVault();
  }
}

export function resolveVaultApiKey(provider = "", explicitKey = "", botId = "") {
  const trimmed = String(explicitKey || "").trim();
  if (trimmed) return trimmed;
  const vault = loadLocalKeysVault();
  if (botId && vault.bots && vault.bots[botId]) {
    return String(vault.bots[botId]).trim();
  }
  const prov = String(provider || "").toLowerCase();
  if (prov && vault.providers && vault.providers[prov]) {
    return String(vault.providers[prov]).trim();
  }
  if (prov === "openrouter" && process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  if ((prov === "openai") && process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if ((prov === "anthropic" || prov === "claude") && process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (prov === "gemini" && (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
    return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  }
  return "";
}

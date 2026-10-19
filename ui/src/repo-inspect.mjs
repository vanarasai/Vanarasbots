// Repository symbol map and mounted-directory inspection.
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "./config.mjs";
import { listAgentCodeFiles } from "./worktree.mjs";

// Extract a compact architectural Symbol & Route Map from source files in a directory
export function extractRepositorySymbolMap(rootDir) {
  const symbolMap = [];
  const candidateDirs = [rootDir, path.join(rootDir, "src"), path.join(rootDir, "ui")];
  const visited = new Set();

  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!/\.(js|mjs|ts|py|rs|go|swift)$/i.test(ent.name)) continue;
      const fullPath = path.join(dir, ent.name);
      if (visited.has(fullPath)) continue;
      visited.add(fullPath);

      try {
        const src = fs.readFileSync(fullPath, "utf8").slice(0, 48000);
        const relFile = path.relative(rootDir, fullPath);
        const symbols = [];
        const symRx = /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)|class\s+([a-zA-Z0-9_]+)|def\s+([a-zA-Z0-9_]+)\s*\(|(?:pub\s+)?(?:fn|struct|enum)\s+([a-zA-Z0-9_]+)|req\.url\s*===\s*["'](\/api\/[^"']+)["']/g;
        let m;
        while ((m = symRx.exec(src)) !== null && symbols.length < 18) {
          const sym = m[1] || m[2] || m[3] || m[4] || (m[5] ? `route:${m[5]}` : "");
          if (sym && !symbols.includes(sym)) symbols.push(sym);
        }
        if (symbols.length > 0) {
          symbolMap.push({ file: relFile, symbols });
        }
      } catch {}
      if (symbolMap.length >= 16) break;
    }
  }
  return symbolMap;
}

// Gather grounded filesystem, symbol map & git snapshot from a mounted directory
export function inspectMountedDirectory(targetPath, codeDir = "") {
  const resolved = path.resolve(ROOT_DIR, targetPath || ".");
  if (!fs.existsSync(resolved)) {
    return { exists: false, path: resolved, summary: `Directory not found: ${resolved}` };
  }

  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(e => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "target")
      .slice(0, 35)
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name));

    const snippets = [];
    for (const candidate of ["Cargo.toml", "package.json", "README.md"]) {
      const p = path.join(resolved, candidate);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const content = fs.readFileSync(p, "utf8").slice(0, 600);
        snippets.push(`--- ${candidate} ---\n${content}`);
      }
    }

    // Include live source files from the agent's workspace so the agent never stops with "Let me first inspect the current state of my workspace"
    const wsDir = codeDir && fs.existsSync(codeDir) ? codeDir : resolved;
    const wsFiles = listAgentCodeFiles(wsDir)
      .filter(f => !/^test_r3_/i.test(f.name))
      .sort((a, b) => {
        const aIsTest = /(?:^|\/)test_|_test\./i.test(a.name) ? 1 : 0;
        const bIsTest = /(?:^|\/)test_|_test\./i.test(b.name) ? 1 : 0;
        if (aIsTest !== bIsTest) return aIsTest - bIsTest;
        const aIsCode = /\.(py|js|mjs|ts|rs|go|html)$/i.test(a.name) ? 0 : 1;
        const bIsCode = /\.(py|js|mjs|ts|rs|go|html)$/i.test(b.name) ? 0 : 1;
        if (aIsCode !== bIsCode) return aIsCode - bIsCode;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
    const wsDigest = wsFiles.length > 0
      ? `--- CURRENT WORKSPACE SOURCE FILES (ALREADY LOADED IN CONTEXT — DO NOT STOP TO INSPECT) ---\n` +
        wsFiles.slice(0, 16).map(f => {
          const raw = String(f.content || "");
          const body = raw.length > 18000
            ? `${raw.slice(0, 18000)}\n# [Context preview capped at 18000/${f.size}B — full file on disk is intact]`
            : raw;
          return `=== ${f.name} (${f.size}B) ===\n${body}`;
        }).join("\n\n")
      : "";

    const symbolMap = extractRepositorySymbolMap(wsFiles.length > 0 ? wsDir : resolved);
    const symbolDigest = symbolMap.length > 0
      ? `--- SYMBOL & ROUTE MAP ---\n` + symbolMap.map(s => `• ${s.file}: ${s.symbols.join(", ")}`).join("\n")
      : "";

    return {
      exists: true,
      path: resolved,
      entries,
      symbolMap,
      snippets,
      workspaceFiles: wsFiles.map(f => ({ name: f.name, size: f.size })),
      summary: `Mounted Path: ${resolved}\nTop-level files: ${entries.join(", ")}\n${wsDigest ? wsDigest + "\n\n" : ""}${symbolDigest ? symbolDigest + "\n\n" : ""}${snippets.join("\n\n")}`
    };
  } catch (e) {
    return { exists: false, path: resolved, summary: `Error inspecting ${resolved}: ${e.message}` };
  }
}

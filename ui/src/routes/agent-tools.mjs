// HTTP routes: /api/agent/tool, /api/mcp/discover
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { executeAgentToolInternal } from "../agent-tools.mjs";
import { readJsonBody, sendJson, sendRouteError } from "../http-utils.mjs";
import { inspectProject, projectFromRequest } from "../projects.mjs";

export async function handleAgentToolsRoutes(req, res) {
  // 2D. Per-Agent Tool & MCP Server Executor (/api/agent/tool)
  if (req.method === "POST" && req.url === "/api/agent/tool") {
    try {
      const body = await readJsonBody(req);
      // The project comes from the room, not from the tool arguments.
      const resObj = await executeAgentToolInternal({ ...body, projectPath: projectFromRequest(req, body) });
      return sendJson(res, resObj.status || 200, resObj.data || resObj);
    } catch (e) {
      return sendRouteError(res, e, 500);
    }
  }

  // 2D-2. Host MCP Ecosystem Auto-Discovery (/api/mcp/discover)
  if ((req.method === "GET" || req.method === "POST") && req.url === "/api/mcp/discover") {
    try {
      const discovered = [];
      const home = os.homedir();

      function sanitizeServer(srv) {
        const clean = {
          name: String(srv.name || "mcp-server"),
          source: String(srv.source || "Local Config"),
          command: String(srv.command || ""),
          args: Array.isArray(srv.args) ? srv.args.map(a => {
            let s = String(a);
            s = s.replace(/sk-[a-zA-Z0-9_-]{10,}/gi, "***REDACTED***");
            s = s.replace(/ghp_[a-zA-Z0-9]{10,}/gi, "***REDACTED***");
            s = s.replace(/AIzaSy[a-zA-Z0-9_-]{10,}/gi, "***REDACTED***");
            return s;
          }) : [],
          env: {}
        };

        if (srv.env && typeof srv.env === "object") {
          for (const [key, val] of Object.entries(srv.env)) {
            const lowerKey = key.toLowerCase();
            const valStr = String(val ?? "");
            if (
              lowerKey.includes("key") ||
              lowerKey.includes("token") ||
              lowerKey.includes("secret") ||
              lowerKey.includes("password") ||
              lowerKey.includes("auth") ||
              /sk-[a-zA-Z0-9_-]+/i.test(valStr) ||
              /ghp_[a-zA-Z0-9]+/i.test(valStr) ||
              /AIzaSy[a-zA-Z0-9_-]+/i.test(valStr)
            ) {
              clean.env[key] = "***REDACTED***";
            } else {
              clean.env[key] = valStr;
            }
          }
        }
        return clean;
      }

      // 1. Cursor MCP: ~/.cursor/mcp.json
      const cursorPath = path.join(home, ".cursor", "mcp.json");
      if (fs.existsSync(cursorPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
          const servers = cfg.mcpServers || cfg.servers || {};
          for (const [name, def] of Object.entries(servers)) {
            if (def && typeof def === "object") {
              discovered.push(sanitizeServer({
                name,
                source: "Cursor",
                command: def.command || "",
                args: def.args || [],
                env: def.env || {}
              }));
            }
          }
        } catch {}
      }

      // 2. Claude Desktop & Claude Code
      const claudeDesktopPaths = [
        path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        path.join(home, ".config", "Claude", "claude_desktop_config.json"),
        path.join(home, ".claude.json")
      ];
      for (const cp of claudeDesktopPaths) {
        if (fs.existsSync(cp)) {
          try {
            const cfg = JSON.parse(fs.readFileSync(cp, "utf8"));
            const servers = cfg.mcpServers || cfg.servers || {};
            for (const [name, def] of Object.entries(servers)) {
              if (def && typeof def === "object") {
                if (!discovered.some(d => d.name === name)) {
                  discovered.push(sanitizeServer({
                    name,
                    source: "Claude",
                    command: def.command || "",
                    args: def.args || [],
                    env: def.env || {}
                  }));
                }
              }
            }
          } catch {}
        }
      }

      // 3. Google Antigravity: ~/.gemini/antigravity/mcp/
      const antigravityDir = path.join(home, ".gemini", "antigravity", "mcp");
      if (fs.existsSync(antigravityDir)) {
        try {
          const entries = fs.readdirSync(antigravityDir, { withFileTypes: true });
          for (const ent of entries) {
            if (ent.isDirectory() && !ent.name.startsWith(".")) {
              if (!discovered.some(d => d.name === ent.name)) {
                discovered.push(sanitizeServer({
                  name: ent.name,
                  source: "Google Antigravity",
                  command: "npx",
                  args: ["-y", `@modelcontextprotocol/server-${ent.name}`],
                  env: {}
                }));
              }
            }
          }
        } catch {}
      }

      // Fallback default options if none found
      if (discovered.length === 0) {
        // A filesystem server is only suggested for the room's own project folder.
        const project = inspectProject(req.headers["x-vanaras-project"] ? decodeURIComponent(String(req.headers["x-vanaras-project"])) : "");
        if (project.ok) {
          discovered.push(sanitizeServer({
            name: "filesystem",
            source: "Default MCP",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", project.root],
            env: {}
          }));
        }
        discovered.push(
          sanitizeServer({
            name: "fetch",
            source: "Default MCP",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-fetch"],
            env: {}
          })
        );
      }

      return sendJson(res, 200, { ok: true, servers: discovered });
    } catch (e) {
      return sendRouteError(res, e, 500);
    }
  }

  return false;
}

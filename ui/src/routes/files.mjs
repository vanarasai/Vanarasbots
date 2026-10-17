// HTTP routes: /api/save-project, /api/workspace/media, /api/workspace/web-preview
import fs from "node:fs";
import path from "node:path";
import { PORT, ROOT_DIR, WORKTREES_DIR } from "../config.mjs";
import { readJsonBody, sendJson } from "../http-utils.mjs";
import { ensureAgentPortServerRunning } from "../port-supervisor.mjs";
import { isPathInside } from "../util.mjs";
import { ensureAgentWorktree } from "../worktree.mjs";

export async function handleFilesRoutes(req, res) {
  // 8. Multi-File Project / Deliverable Save (Supports saving into Mounted Folder or vanaras/projects/)
  if (req.method === "POST" && req.url === "/api/save-project") {
    try {
      const { projectName, mountPath, files = [] } = await readJsonBody(req);
      if (!Array.isArray(files) || files.length === 0) {
        return sendJson(res, 400, { error: "Missing files array" });
      }
      const slug = (projectName || "workspace-output").replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
      const baseTarget = mountPath && fs.existsSync(mountPath)
        ? path.resolve(mountPath)
        : path.resolve(ROOT_DIR, "projects", slug);

      const savedPaths = [];
      for (const file of files) {
        const relName = (file.name || "artifact.md").replace(/^\/+/, "").replace(/\.\./g, "");
        const safePath = path.resolve(baseTarget, relName);
        if (!isPathInside(safePath, baseTarget)) continue;
        fs.mkdirSync(path.dirname(safePath), { recursive: true });
        fs.writeFileSync(safePath, file.content || "", "utf8");
        savedPaths.push(safePath);
      }
      return sendJson(res, 200, {
        success: true,
        projectDir: baseTarget,
        savedPaths
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 10. Workspace Media & Webpage Streaming Endpoint (GET/HEAD /api/workspace/media?path=...)
  if ((req.method === "GET" || req.method === "HEAD") && req.url.startsWith("/api/workspace/media")) {
    try {
      const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
      let rawPath = decodeURIComponent(parsedUrl.searchParams.get("path") || "").trim();
      const botId = parsedUrl.searchParams.get("botId") || "";
      const forceDownload = parsedUrl.searchParams.get("download") === "1";

      rawPath = rawPath.replace(/^file:\/\//i, "").trim();
      if (!rawPath || rawPath.includes("..")) {
        return sendJson(res, 400, { ok: false, error: "Invalid media path" });
      }

      const candidateFiles = [];
      const addCandidate = (p) => {
        try {
          const resolved = path.resolve(p);
          if ((isPathInside(resolved, ROOT_DIR) || isPathInside(resolved, WORKTREES_DIR)) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            candidateFiles.push({ path: resolved, mtimeMs: fs.statSync(resolved).mtimeMs });
          }
        } catch {}
      };

      if (path.isAbsolute(rawPath)) {
        addCandidate(rawPath);
      }

      const cleanRel = rawPath.replace(/^\/+/, "");
      addCandidate(path.join(ROOT_DIR, cleanRel));
      addCandidate(path.join(ROOT_DIR, "output", path.basename(cleanRel)));
      addCandidate(path.join(ROOT_DIR, "output_test", path.basename(cleanRel)));

      if (botId) {
        try {
          const wt = ensureAgentWorktree(botId, botId.replace(/^bot_/, "").toUpperCase());
          addCandidate(path.join(wt.codeDir, cleanRel));
          addCandidate(path.join(wt.worktreePath, cleanRel));
          addCandidate(path.join(wt.codeDir, "output", path.basename(cleanRel)));
          addCandidate(path.join(wt.worktreePath, "output", path.basename(cleanRel)));
        } catch {}
      }

      if (fs.existsSync(WORKTREES_DIR)) {
        try {
          for (const ent of fs.readdirSync(WORKTREES_DIR, { withFileTypes: true })) {
            if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
            const sibWt = path.join(WORKTREES_DIR, ent.name);
            addCandidate(path.join(sibWt, cleanRel));
            addCandidate(path.join(sibWt, "output", path.basename(cleanRel)));
            addCandidate(path.join(sibWt, "output_test", path.basename(cleanRel)));
            const awDir = path.join(sibWt, "agent_workspace");
            if (fs.existsSync(awDir)) {
              for (const sub of fs.readdirSync(awDir, { withFileTypes: true })) {
                if (sub.isDirectory() && !sub.name.startsWith(".")) {
                  const subDir = path.join(awDir, sub.name);
                  addCandidate(path.join(subDir, cleanRel));
                  addCandidate(path.join(subDir, "output", path.basename(cleanRel)));
                  addCandidate(path.join(subDir, "output_test", path.basename(cleanRel)));
                }
              }
            }
          }
        } catch {}
      }

      if (candidateFiles.length === 0) {
        return sendJson(res, 404, { ok: false, error: `Media file not found: ${rawPath}` });
      }

      candidateFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const chosenPath = candidateFiles[0].path;
      const stat = fs.statSync(chosenPath);
      const ext = path.extname(chosenPath).toLowerCase();

      const mimeMap = {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".ogg": "audio/ogg",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".flac": "audio/flac",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".html": "text/html; charset=utf-8",
        ".htm": "text/html; charset=utf-8",
        ".pdf": "application/pdf",
        ".json": "application/json; charset=utf-8",
        ".txt": "text/plain; charset=utf-8"
      };
      const contentType = mimeMap[ext] || "application/octet-stream";
      const baseHeaders = {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache"
      };
      if (forceDownload) {
        baseHeaders["Content-Disposition"] = `attachment; filename="${path.basename(chosenPath).replace(/"/g, "")}"`;
      }

      const rangeHeader = req.headers.range;
      if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader)) {
        const parts = rangeHeader.replace(/bytes=/, "").split("-");
        const start = parts[0] ? parseInt(parts[0], 10) : 0;
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        if (start >= stat.size || end >= stat.size || start > end) {
          res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          ...baseHeaders,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Content-Length": end - start + 1
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        fs.createReadStream(chosenPath, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        ...baseHeaders,
        "Content-Length": stat.size
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(chosenPath).pipe(res);
      return;
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // 10B. Live Agent Webpage Preview & Auto-Boot Proxy (GET /api/workspace/web-preview?url=...)
  if (req.method === "GET" && req.url.startsWith("/api/workspace/web-preview")) {
    try {
      const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
      const rawUrl = decodeURIComponent(parsedUrl.searchParams.get("url") || "").trim();
      const botId = parsedUrl.searchParams.get("botId") || "bot_r1";
      let targetUrlObj = null;
      try {
        targetUrlObj = new URL(rawUrl);
      } catch {
        return sendJson(res, 400, { ok: false, error: "Invalid preview URL" });
      }
      const targetPort = Number(targetUrlObj.port || 80);
      if (targetPort && targetPort !== Number(PORT)) {
        await ensureAgentPortServerRunning(targetPort, botId);
      }

      const backendPath = `${targetUrlObj.pathname || "/"}${targetUrlObj.search || ""}`;
      const backendUrl = `http://127.0.0.1:${targetPort}${backendPath}`;

      try {
        const fetchCtrl = new AbortController();
        const fetchTimer = setTimeout(() => fetchCtrl.abort(), 4000);
        const upstream = await fetch(backendUrl, {
          signal: fetchCtrl.signal,
          headers: { "Accept": req.headers.accept || "*/*" }
        });
        clearTimeout(fetchTimer);

        const contentType = upstream.headers.get("content-type") || "text/html; charset=utf-8";
        if (contentType.includes("text/html")) {
          let html = await upstream.text();
          const baseTag = `<base href="http://localhost:${targetPort}/">`;
          if (/<head\b[^>]*>/i.test(html)) {
            html = html.replace(/(<head\b[^>]*>)/i, `$1\n  ${baseTag}`);
          } else {
            html = `<head>${baseTag}</head>\n${html}`;
          }
          res.writeHead(upstream.status, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache"
          });
          res.end(html);
          return;
        } else {
          res.writeHead(upstream.status, {
            "Content-Type": contentType,
            "Cache-Control": "no-cache"
          });
          if (upstream.body) {
            const reader = upstream.body.getReader();
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              res.write(value);
            }
          }
          res.end();
          return;
        }
      } catch (proxyErr) {
        // Fallback: Return clean auto-refreshing loading shell so the iframe never appears as a blank white box
        const loadingHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Loading Web Preview...</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #0f172a; color: #f8fafc; text-align: center; }
    .box { padding: 24px; max-width: 380px; }
    .spinner { width: 32px; height: 32px; border: 3px solid rgba(255,255,255,0.15); border-top-color: #38bdf8; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; color: #f1f5f9; }
    p { margin: 0 0 16px; font-size: 12px; color: #94a3b8; line-height: 1.5; }
    a { display: inline-block; padding: 6px 14px; font-size: 12px; font-weight: 600; color: #38bdf8; text-decoration: none; border: 1px solid rgba(56,189,248,0.3); border-radius: 6px; }
  </style>
  <script>
    setTimeout(function() { window.location.reload(); }, 1200);
  </script>
</head>
<body>
  <div class="box">
    <div class="spinner"></div>
    <h3>Starting App Preview on Port ${targetPort}...</h3>
    <p>Connecting to <code>http://localhost:${targetPort}</code>. Connecting automatically...</p>
    <a href="http://localhost:${targetPort}" target="_blank">Open in New Tab</a>
  </div>
</body>
</html>`;
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache"
        });
        res.end(loadingHtml);
        return;
      }
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  return false;
}

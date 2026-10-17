// Static UI files (final fallthrough: always responds).
//
// Only the app shell and its image assets are public. Everything else under ui/ is private state or
// source: the API-key vault (.vanaras-keys.json), per-agent memory (.vanaras-agents/), the workspace
// JSON, and the server's own modules. Serving the directory wholesale made all of it addressable.
import fs from "node:fs";
import path from "node:path";
import { UI_DIR } from "../config.mjs";
import { isPathInside } from "../util.mjs";

const PAGES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/canvas.html", "canvas.html"]
]);

const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".gif": "image/gif"
};

const AVATARS_DIR = path.join(UI_DIR, "avatars");

function sendFile(res, file, contentType, cacheable) {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": cacheable ? "public, max-age=86400" : "no-cache, no-store, must-revalidate"
  });
  fs.createReadStream(file).pipe(res);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

export async function handleStaticRoutes(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(String(req.url || "/").split("?")[0]);
  } catch {
    // A malformed escape (e.g. "%E0%A4%A") must not throw out of the handler.
    return sendText(res, 400, "Bad request");
  }

  const hasTraversal = pathname.split("/").includes("..");
  if (hasTraversal) return sendText(res, 400, "Bad request");

  const page = PAGES.get(pathname);
  if (page) return sendFile(res, path.join(UI_DIR, page), "text/html; charset=utf-8", false);

  if (pathname.startsWith("/avatars/")) {
    const target = path.resolve(UI_DIR, "." + pathname);
    const type = IMAGE_TYPES[path.extname(target).toLowerCase()];
    if (type && isPathInside(target, AVATARS_DIR) && fs.existsSync(target) && fs.statSync(target).isFile()) {
      return sendFile(res, target, type, true);
    }
    return sendText(res, 404, "Not found");
  }

  // Any other request that names a file is not public. Extensionless paths are client-side routes of the
  // single-page app and get the app shell.
  if (path.extname(pathname)) return sendText(res, 404, "Not found");
  return sendFile(res, path.join(UI_DIR, "index.html"), "text/html; charset=utf-8", false);
}

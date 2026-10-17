// Static UI files (final fallthrough: always responds).
import fs from "node:fs";
import path from "node:path";
import { UI_DIR } from "../config.mjs";
import { isPathInside } from "../util.mjs";

export async function handleStaticRoutes(req, res) {
  // Static files
  const reqPath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);

  const targetFile = path.resolve(UI_DIR, "." + reqPath);

  if (isPathInside(targetFile, UI_DIR) && fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
    const ext = path.extname(targetFile).toLowerCase();
    let contentType = "text/html; charset=utf-8";
    if (ext === ".js" || ext === ".mjs") contentType = "application/javascript";
    else if (ext === ".css") contentType = "text/css";
    else if (ext === ".json") contentType = "application/json";
    else if (ext === ".png") contentType = "image/png";
    else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
    else if (ext === ".svg") contentType = "image/svg+xml";
    else if (ext === ".webp") contentType = "image/webp";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": ext === ".png" ? "public, max-age=86400" : "no-cache, no-store, must-revalidate"
    });
    fs.createReadStream(targetFile).pipe(res);
  } else {
    const indexPath = path.join(UI_DIR, "index.html");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate"
    });
    fs.createReadStream(indexPath).pipe(res);
  }
}

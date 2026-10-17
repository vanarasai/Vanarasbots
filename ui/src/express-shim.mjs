// Writes the built-in express-compatible shim agents' preview apps resolve when express is not installed.
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "./config.mjs";

export const RUNTIME_NODE_MODULES = path.join(ROOT_DIR, ".vanaras-runtime", "node_modules");

export function ensureBuiltinExpressShim() {
  const expressDir = path.join(RUNTIME_NODE_MODULES, "express");
  const indexMjs = path.join(expressDir, "index.mjs");
  if (fs.existsSync(indexMjs)) return RUNTIME_NODE_MODULES;
  try {
    fs.mkdirSync(expressDir, { recursive: true });
    fs.writeFileSync(
      path.join(expressDir, "package.json"),
      JSON.stringify({ name: "express", version: "4.18.2", type: "module", main: "index.mjs", exports: "./index.mjs" }, null, 2),
      "utf8"
    );
    const shimSource = `import http from 'http';
import fs from 'fs';
import path from 'path';

function matchRoute(pattern, pathname) {
  if (pattern === pathname) return {};
  const patParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      params[patParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

function createExpressApp() {
  const routes = [];
  const middlewares = [];
  const errorHandlers = [];

  const app = (req, res) => {
    const parsedUrl = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    req.path = parsedUrl.pathname;
    req.query = Object.fromEntries(parsedUrl.searchParams.entries());
    req.params = {};

    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (obj) => {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      res.end(JSON.stringify(obj));
      return res;
    };
    res.send = (body) => {
      if (typeof body === 'object' && body !== null && !Buffer.isBuffer(body)) {
        return res.json(body);
      }
      if (!res.headersSent) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      res.end(body);
      return res;
    };

    const runErrorHandlers = (err) => {
      let eIdx = 0;
      const nextErr = (e) => {
        if (res.writableEnded) return;
        const eh = errorHandlers[eIdx++];
        if (!eh) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e?.message || 'Internal Server Error' }));
          return;
        }
        try {
          eh(e, req, res, nextErr);
        } catch (err2) {
          nextErr(err2);
        }
      };
      nextErr(err);
    };

    let mwIdx = 0;
    const runNextMiddleware = (err) => {
      if (err) return runErrorHandlers(err);
      if (res.writableEnded) return;
      const mw = middlewares[mwIdx++];
      if (mw) {
        if (mw.prefix && !req.path.startsWith(mw.prefix)) {
          return runNextMiddleware();
        }
        try {
          const origPath = req.path;
          if (mw.prefix && mw.prefix !== '/') {
            req.path = origPath.slice(mw.prefix.length) || '/';
          }
          const maybePromise = mw.fn(req, res, (e) => {
            req.path = origPath;
            runNextMiddleware(e);
          });
          if (maybePromise && typeof maybePromise.catch === 'function') {
            maybePromise.catch(runErrorHandlers);
          }
        } catch (e) {
          runErrorHandlers(e);
        }
        return;
      }

      for (const r of routes) {
        if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
        const params = matchRoute(r.pattern, req.path);
        if (params) {
          req.params = params;
          try {
            const out = r.handler(req, res, runErrorHandlers);
            if (out && typeof out.catch === 'function') {
              out.catch(runErrorHandlers);
            }
          } catch (e) {
            runErrorHandlers(e);
          }
          return;
        }
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found', path: req.path }));
    };

    runNextMiddleware();
  };

  app.use = (arg1, arg2) => {
    const prefix = typeof arg1 === 'string' ? arg1 : '';
    const fn = typeof arg1 === 'function' ? arg1 : arg2;
    if (typeof fn === 'function') {
      if (fn.length === 4) {
        errorHandlers.push(fn);
      } else {
        middlewares.push({ prefix, fn });
      }
    }
    return app;
  };
  for (const m of ['get', 'post', 'put', 'delete', 'patch']) {
    app[m] = (pattern, handler) => {
      routes.push({ method: m.toUpperCase(), pattern, handler });
      return app;
    };
  }
  app.listen = (port, hostOrCb, maybeCb) => {
    const cb = typeof hostOrCb === 'function' ? hostOrCb : maybeCb;
    const host = typeof hostOrCb === 'string' ? hostOrCb : '127.0.0.1';
    const srv = http.createServer(app);
    srv.listen(port, host, cb);
    return srv;
  };
  return app;
}

createExpressApp.json = () => (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  let raw = '';
  req.on('data', c => { raw += c.toString('utf8'); });
  req.on('end', () => {
    if (!raw.trim()) {
      req.body = {};
      return next();
    }
    try {
      req.body = JSON.parse(raw);
      next();
    } catch (e) {
      e.type = 'entity.parse.failed';
      next(e);
    }
  });
};

createExpressApp.static = (rootDir) => (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const rel = (req.path === '/' ? '/index.html' : req.path).replace(/^\\/+/, '');
  if (!rel || rel.includes('..')) return next();
  const full = path.resolve(rootDir, rel);
  if (!full.startsWith(path.resolve(rootDir)) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return next();
  }
  const ext = path.extname(full).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
};

export default createExpressApp;
`;
    fs.writeFileSync(indexMjs, shimSource, "utf8");
  } catch {}
  return RUNTIME_NODE_MODULES;
}

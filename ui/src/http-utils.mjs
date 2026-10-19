// Request body parsing and JSON responses.
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    const MAX_BYTES = 15 * 1024 * 1024;
    req.on("data", chunk => {
      body += chunk;
      if (body.length > MAX_BYTES) {
        req.destroy();
        reject(new Error("Request payload exceeds 15MB limit"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(data));
}

// A route's error response: a missing/invalid project (ProjectError, status 409 with a code) keeps its code so
// the UI can ask for a project; anything else is reported with the route's fallback status.
export function sendRouteError(res, err, fallbackStatus = 500) {
  if (err && err.status === 409 && err.code) {
    return sendJson(res, 409, { ok: false, code: err.code, error: err.message, project: err.details });
  }
  return sendJson(res, fallbackStatus, { ok: false, error: err?.message || String(err) });
}

// Command permission policy (DENY/ASK/ALLOW) and the loopback-only request boundary.
export function checkCommandPermission(cmdStr, { botId = "", role = "", permissionPolicy = "auto" } = {}) {
  const trimmed = String(cmdStr || "").trim();

  // 1. Strict DENY patterns (Destructive system operations, root escapes, fork bombs)
  const denyPatterns = [
    /\brm\s+-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\s+(?:(?:\/|\/\*|~|\$HOME|\.\.)(?:\s|$)|(?:\/(?:etc|usr|bin|sbin|var|System|Library))\b)/,
    /(?::\(\)\s*\{\s*:\|:&\s*\};:|:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};:)/,
    /\b(mkfs|dd\s+if=|\bshutdown\b|\breboot\b|\binit\s+0)\b/,
    />\s*(?:\/etc\/|\/usr\/|\/System\/|\/Library\/|\/dev\/(?!null\b))/,
    /\bchmod\s+(?:-R\s+)?777\s+(?:(?:\/|~|\$HOME)(?:\s|$))/
  ];
  for (const pat of denyPatterns) {
    if (pat.test(trimmed)) {
      return {
        policy: "deny",
        reason: `Destructive system command matches security deny rule (${pat.source}): execution permanently forbidden.`
      };
    }
  }

  // 2. ASK patterns (Actions with external side effects or high impact)
  const askPatterns = [
    { regex: /\bgit\s+(?:push\b|reset\s+--hard\s+origin)/, reason: "Command pushes code to remote repository or resets to remote origin." },
    { regex: /\b(?:npm|yarn|pnpm)\s+(?:publish|login)\b/, reason: "Command publishes package or modifies credentials." },
    { regex: /\b(?:curl|wget)\s+[^|;&]+\|\s*(?:ba|z)?sh\b/, reason: "Piping remote network script directly to shell execution." },
    { regex: /\brm\s+-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\b/, reason: "Recursive forced deletion command requires confirmation." }
  ];

  if (permissionPolicy === "strict" || permissionPolicy === "ask") {
    const isSafeRead = /^(?:ls|cat|pwd|git\s+(?:status|diff|log|branch)|node\s+--check|echo|which|grep|find)\b/.test(trimmed);
    if (!isSafeRead) {
      return {
        policy: "ask",
        reason: `Agent is in strict approval mode: command '${trimmed.slice(0, 50)}...' requires user authorization.`
      };
    }
  }

  for (const p of askPatterns) {
    if (p.regex.test(trimmed)) {
      return { policy: "ask", reason: p.reason };
    }
  }

  return { policy: "allow" };
}

// Local-only request boundary. The API can run shell commands, so it must only be driven by this
// machine's own UI/CLI. Two checks:
//  - Host must be a loopback name. DNS-rebinding pages reach 127.0.0.1 under an attacker hostname,
//    so their Host header is not loopback.
//  - Browser Origin, when present, must be a loopback origin. Ordinary websites calling
//    http://localhost:3000 send their own Origin. Non-browser clients (CLI, curl) send none.
// CORS is echoed only for loopback origins; it is never "*".
export const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function parseLoopbackHostname(hostValue) {
  if (!hostValue) return null;
  try {
    return new URL(`http://${hostValue}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

export function isLoopbackOrigin(origin) {
  if (!origin || origin === "null") return false;
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") &&
      LOOPBACK_HOSTNAMES.has(u.hostname.replace(/^\[|\]$/g, "").toLowerCase());
  } catch {
    return false;
  }
}

export function enforceLocalRequestBoundary(req, res) {
  const host = req.headers.host;
  if (host && !LOOPBACK_HOSTNAMES.has(parseLoopbackHostname(host))) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden host: Vanaras only serves this machine" }));
    return false;
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const safeMethod = req.method === "GET" || req.method === "HEAD";
    // Opaque "null" origins (sandboxed frames, file://) may read nothing and change nothing:
    // they get no CORS grant, and only side-effect-free methods are let through.
    const allowed = isLoopbackOrigin(origin) || (origin === "null" && safeMethod);
    if (!allowed) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Forbidden origin: Vanaras only accepts requests from its own app" }));
      return false;
    }
    if (isLoopbackOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
  }
  return true;
}

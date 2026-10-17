// Command permission policy (DENY/ASK/ALLOW) and the loopback-only request boundary.
// These rules are guardrails against accidents and prompt-injected mistakes, not a sandbox: a string
// policy cannot stop a determined shell user (e.g. `python -c 'shutil.rmtree("/")'`). Real isolation comes
// from the per-agent worktree, the loopback-only boundary, and the human approval step.
export function checkCommandPermission(cmdStr, { permissionPolicy = "auto" } = {}) {
  const trimmed = String(cmdStr || "").trim();
  // Shells strip quotes and backslash escapes before running a command, so judge that form as well:
  // `rm -rf "/"`, `r\m -rf /` and `rm -rf '/'` must not slip past a literal-text match.
  const normalized = trimmed.replace(/['"`]/g, "").replace(/\\(?=\S)/g, "");
  const matches = (re) => re.test(trimmed) || re.test(normalized);

  // 1. Strict DENY patterns (Destructive system operations, root escapes, fork bombs)
  const denyPatterns = [
    /\brm\s+-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\s+(?:(?:\/|\/\*|~|\$HOME|\.\.)(?:\s|$)|(?:\/(?:etc|usr|bin|sbin|var|System|Library))\b)/,
    /(?::\(\)\s*\{\s*:\|:&\s*\};:|:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};:)/,
    /\b(?:mkfs\b|dd\s+if=|shutdown\b|reboot\b|init\s+0\b)/,
    /\bdd\b[^|;&\n]*\bof=\/dev\/(?!null\b)/,
    />\s*(?:\/etc\/|\/usr\/|\/System\/|\/Library\/|\/dev\/(?!null\b))/,
    /\bchmod\s+(?:-R\s+)?777\s+(?:(?:\/|~|\$HOME)(?:\s|$))/
  ];
  for (const pat of denyPatterns) {
    if (matches(pat)) {
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
    // A "safe read" is a single simple command: any chaining, piping, redirection or substitution
    // (`ls; curl x | sh`, `echo $(...)`) makes it something else.
    const isSimple = !/[;&|<>`$()\n\r]/.test(trimmed);
    const isSafeRead = isSimple && /^(?:ls|cat|pwd|git\s+(?:status|diff|log|branch)|node\s+--check|echo|which|grep|find)\b/.test(trimmed);
    if (!isSafeRead) {
      return {
        policy: "ask",
        reason: `Agent is in strict approval mode: command '${trimmed.slice(0, 50)}...' requires user authorization.`
      };
    }
  }

  for (const p of askPatterns) {
    if (matches(p.regex)) {
      return { policy: "ask", reason: p.reason };
    }
  }

  return { policy: "allow" };
}

// ---------------------------------------------------------------------------------------------------
// Subagent capability policy. This is an allowlist, enforced in one place before any tool runs, so a
// tool added later is denied to restricted subagents by default instead of silently allowed.
// ---------------------------------------------------------------------------------------------------
const SUBAGENT_ALLOWED_TOOLS = {
  explore: ["fs_read", "grep_search", "find_files", "git_status", "git_diff"],
  plan: ["fs_read", "grep_search", "find_files"]
};

export function subagentKind(botId) {
  const m = /^sub_(explore|plan|general)(?:_|$)/.exec(String(botId || ""));
  return m ? m[1] : null;
}

export function checkToolAllowed(botId, toolName) {
  const kind = subagentKind(botId);
  if (!kind) return { allowed: true };
  const allowed = SUBAGENT_ALLOWED_TOOLS[kind];
  if (allowed && !allowed.includes(toolName)) {
    return {
      allowed: false,
      reason: `Access Denied: ${kind} subagent '${botId}' is limited to ${allowed.join(", ")} and cannot run '${toolName}'.`
    };
  }
  if (toolName === "spawn_subagent") {
    return { allowed: false, reason: `Access Denied: subagent '${botId}' cannot spawn further subagents.` };
  }
  return { allowed: true };
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

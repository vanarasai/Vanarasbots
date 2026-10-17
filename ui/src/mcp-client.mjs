// Stdio Model Context Protocol client (JSON-RPC 2.0: initialize, tools/list, tools/call).
import { spawn } from "node:child_process";
import { ROOT_DIR } from "./config.mjs";

// ============================================================================
// REAL MCP STDIO CLIENT (JSON-RPC 2.0 initialize -> tools/list | tools/call)
// ============================================================================

// Split a command line into argv without invoking a shell. Whitespace separates arguments; single quotes
// are literal; double quotes group (with \" and, on POSIX, \\ escapes); outside quotes a backslash escapes
// the next character on POSIX only, so Windows paths such as C:\Tools\mcp.exe survive unchanged.
export function splitCommandLine(commandLine) {
  const posix = process.platform !== "win32";
  const argv = [];
  let cur = "";
  let started = false;
  let quote = null;
  const s = String(commandLine || "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null; else cur += c;
    } else if (quote === '"') {
      if (c === '"') {
        quote = null;
      } else if (c === "\\" && i + 1 < s.length && (s[i + 1] === '"' || (posix && s[i + 1] === "\\"))) {
        cur += s[++i];
      } else {
        cur += c;
      }
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started || cur) { argv.push(cur); cur = ""; started = false; }
    } else if (c === "\\" && posix && i + 1 < s.length) {
      cur += s[++i];
      started = true;
    } else {
      cur += c;
      started = true;
    }
  }
  if (started || cur) argv.push(cur);
  return argv;
}

export function callStdioMcpServer({ commandLine, cwd, method = "tools/list", params = {} }) {
  return new Promise((resolve) => {
    const parts = splitCommandLine(commandLine);
    const bin = parts[0];
    const args = parts.slice(1);
    if (!bin) return resolve({ ok: false, error: "Empty MCP command" });

    let stdoutBuf = "";
    let stderrBuf = "";
    let resolved = false;
    let initHandshakeSent = false;

    const finish = (res) => {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch {}
      resolve(res);
    };

    const child = spawn(bin, args, {
      cwd: cwd || ROOT_DIR,
      env: process.env,
      shell: process.platform === "win32"
    });

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: "MCP server timed out after 12s",
        raw: stdoutBuf.slice(0, 800),
        stderr: stderrBuf.slice(0, 800)
      });
    }, 12000);

    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message, stderr: stderrBuf });
    });

    child.on("close", (code) => {
      if (!resolved) {
        clearTimeout(timer);
        finish({
          ok: false,
          error: `MCP server exited with code ${code}`,
          stderr: stderrBuf,
          stdout: stdoutBuf
        });
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id === 1 && !initHandshakeSent) {
            initHandshakeSent = true;
            const initializedNotif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n";
            const req2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }) + "\n";
            child.stdin.write(initializedNotif + req2);
          } else if (msg.id === 2) {
            clearTimeout(timer);
            finish({ ok: true, result: msg.result || msg.error });
          }
        } catch {}
      }
    });

    const initReq = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "Vanarasbots", version: "2.5.0" }
      }
    }) + "\n";

    try {
      child.stdin.write(initReq);
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, error: e.message });
    }
  });
}

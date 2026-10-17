// Process-group supervision: spawn, signal, and kill whole command trees.
import { spawn } from "node:child_process";
import { buildAgentExecEnv } from "./env.mjs";
import { activeRunProcs } from "./state.mjs";

// Process-group supervision: commands run as `sh -c <cmd>`. Signalling only the `sh` pid leaves
// grandchildren (python3, node, sleep, servers) orphaned and holding stdout pipes/ports open.
// Spawn POSIX commands as their own process-group leader and signal the whole group instead.
export const USE_PROCESS_GROUPS = process.platform !== "win32";

export function signalProcessTree(proc, signal = "SIGTERM") {
  if (!proc || !proc.pid) return false;
  if (USE_PROCESS_GROUPS && proc.__vanarasGroupLeader) {
    try {
      process.kill(-proc.pid, signal);
      return true;
    } catch {
      // Group already gone (ESRCH) — fall through to the direct child signal.
    }
  }
  try { return proc.kill(signal); } catch { return false; }
}

export function killProcessTree(proc, graceMs = 1500) {
  if (!proc || !proc.pid || proc.__vanarasKillRequested) return;
  proc.__vanarasKillRequested = true;
  signalProcessTree(proc, "SIGTERM");
  // Escalate only while we still own the group: the escalation runs once, within a short grace
  // window of our own SIGTERM, so a recycled pgid is not a realistic target.
  const escalate = setTimeout(() => {
    if (USE_PROCESS_GROUPS && proc.__vanarasGroupLeader) {
      try {
        process.kill(-proc.pid, 0);
        process.kill(-proc.pid, "SIGKILL");
      } catch {}
    } else if (proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill("SIGKILL"); } catch {}
    }
  }, graceMs);
  escalate.unref?.();
}

export function spawnShellProcessGroup(command, options = {}) {
  const proc = spawn("sh", ["-c", command], {
    ...options,
    ...(USE_PROCESS_GROUPS ? { detached: true } : {})
  });
  proc.__vanarasGroupLeader = USE_PROCESS_GROUPS;
  return proc;
}

// Stop a tracked run: prefer the promise-aware stop hook so awaiting HTTP handlers resolve now
// instead of waiting for orphaned descendants to close inherited pipes.
export function stopTrackedProcess(proc, reason = "Stopped by user") {
  if (!proc) return;
  if (typeof proc.__vanarasStop === "function") {
    proc.__vanarasStop(reason);
  } else {
    killProcessTree(proc);
  }
}

export function spawnCommandAsync(command, { cwd, worktreePath = "", timeout = 15000, trackKey = null, onProgress = null } = {}) {
  return new Promise((resolve) => {
    const execEnv = buildAgentExecEnv(cwd, worktreePath);
    const proc = spawnShellProcessGroup(command, {
      cwd,
      env: execEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (trackKey) {
      activeRunProcs.set(trackKey, proc);
    }
    let stdout = "";
    let stderr = "";
    let finished = false;
    let lastEmitTs = 0;
    const untrack = () => {
      if (trackKey && activeRunProcs.get(trackKey) === proc) activeRunProcs.delete(trackKey);
    };
    const emitProgressIfNeeded = (force = false) => {
      if (typeof onProgress !== "function") return;
      const now = Date.now();
      if (!force && now - lastEmitTs < 110) return;
      lastEmitTs = now;
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      try { onProgress(combined); } catch {}
    };
    const finishByKill = (exitCode, note, extra = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killProcessTree(proc);
      untrack();
      resolve({ exitCode, output: `${stdout}\n${stderr}\n${note}`.trim(), ...extra });
    };
    proc.__vanarasStop = (reason = "Stopped by user") => finishByKill(130, `[${reason}]`, { stopped: true });
    const timer = setTimeout(() => {
      finishByKill(124, `[Timed out after ${timeout}ms]`, { timedOut: true });
    }, timeout);
    proc.stdout.on("data", chunk => {
      if (stdout.length < 96000) stdout += chunk.toString("utf8");
      emitProgressIfNeeded(false);
    });
    proc.stderr.on("data", chunk => {
      if (stderr.length < 96000) stderr += chunk.toString("utf8");
      emitProgressIfNeeded(false);
    });
    proc.on("error", err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      untrack();
      resolve({ exitCode: 1, output: err.message });
    });
    proc.on("close", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      untrack();
      emitProgressIfNeeded(true);
      const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").slice(0, 6000);
      const exitCode = signal === "SIGTERM" || signal === "SIGKILL" ? 130 : (code ?? 0);
      resolve({ exitCode, output: out, killedBySignal: signal });
    });
  });
}

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const VANARAS_ROOT = path.resolve(__dirname, "..");

export const BASE_URL = process.env.VANARAS_TEST_URL || "http://127.0.0.1:3000";

let spawnedServerProcess = null;

/**
 * Checks if the Vanaras server is responding on /api/health
 */
export async function isServerHealthy(timeoutMs = 1500) {
  try {
    const res = await requestJson("GET", "/api/health", null, {}, timeoutMs);
    return res.status === 200 && res.body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Ensures a Vanaras server is running. If not, spawns an ephemeral instance.
 */
export async function ensureServerRunning(maxWaitMs = 12000) {
  if (await isServerHealthy(1000)) {
    return { spawned: false, url: BASE_URL };
  }

  const serverScript = path.join(VANARAS_ROOT, "ui", "server.mjs");
  if (!fs.existsSync(serverScript)) {
    throw new Error(`Cannot spawn Vanaras server: ${serverScript} does not exist`);
  }

  spawnedServerProcess = spawn(process.execPath, [serverScript], {
    cwd: VANARAS_ROOT,
    env: { ...process.env, PORT: "3000" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  spawnedServerProcess.stdout.on("data", () => {});
  spawnedServerProcess.stderr.on("data", () => {});

  const cleanup = () => {
    if (spawnedServerProcess) {
      try {
        spawnedServerProcess.kill("SIGTERM");
      } catch {}
      spawnedServerProcess = null;
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, 250));
    if (await isServerHealthy(500)) {
      return { spawned: true, url: BASE_URL };
    }
  }

  cleanup();
  throw new Error(`Vanaras server failed to start on ${BASE_URL} within ${maxWaitMs}ms`);
}

/**
 * Cleanly stops any spawned server instance.
 */
export function stopSpawnedServer() {
  if (spawnedServerProcess) {
    try {
      spawnedServerProcess.kill("SIGTERM");
    } catch {}
    spawnedServerProcess = null;
  }
}

/**
 * Perform an HTTP JSON request using native http client.
 */
export function requestJson(method, urlPath, body = null, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlPath, BASE_URL);
    const serializedBody = body !== null && typeof body === "object" ? JSON.stringify(body) : (body || null);

    const reqHeaders = {
      ...headers
    };
    if (serializedBody !== null && !reqHeaders["Content-Type"]) {
      reqHeaders["Content-Type"] = "application/json";
    }
    if (serializedBody !== null && !reqHeaders["Content-Length"]) {
      reqHeaders["Content-Length"] = Buffer.byteLength(serializedBody);
    }

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method.toUpperCase(),
      headers: reqHeaders,
      timeout: timeoutMs
    };

    const req = http.request(options, (res) => {
      let rawData = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { rawData += chunk; });
      res.on("end", () => {
        let parsedJson = null;
        try {
          parsedJson = JSON.parse(rawData);
        } catch {
          parsedJson = rawData;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsedJson,
          raw: rawData
        });
      });
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP request timed out after ${timeoutMs}ms for ${method} ${urlPath}`));
    });

    req.on("error", (err) => {
      reject(err);
    });

    if (serializedBody !== null) {
      req.write(serializedBody);
    }
    req.end();
  });
}

/**
 * Lightweight assertion primitives.
 */
export function assert(condition, message = "Assertion failed") {
  if (!condition) {
    const err = new Error(message);
    Error.captureStackTrace(err, assert);
    throw err;
  }
}

export function assertEqual(actual, expected, message = "") {
  if (actual !== expected) {
    const msg = message ? `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` : `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    const err = new Error(msg);
    Error.captureStackTrace(err, assertEqual);
    throw err;
  }
}

export function assertIncludes(actual, target, message = "") {
  if (typeof actual === "string") {
    if (!actual.includes(target)) {
      const msg = message ? `${message}: expected string to include "${target}"` : `Expected string to include "${target}"`;
      const err = new Error(msg);
      Error.captureStackTrace(err, assertIncludes);
      throw err;
    }
  } else if (Array.isArray(actual)) {
    if (!actual.includes(target)) {
      const msg = message ? `${message}: expected array to include ${JSON.stringify(target)}` : `Expected array to include ${JSON.stringify(target)}`;
      const err = new Error(msg);
      Error.captureStackTrace(err, assertIncludes);
      throw err;
    }
  } else {
    throw new Error(`assertIncludes target must be string or array, got ${typeof actual}`);
  }
}

export function assertMatch(actual, regex, message = "") {
  if (!regex.test(String(actual))) {
    const msg = message ? `${message}: expected "${actual}" to match regex ${regex}` : `Expected "${actual}" to match regex ${regex}`;
    const err = new Error(msg);
    Error.captureStackTrace(err, assertMatch);
    throw err;
  }
}

/**
 * Test Registry & Runner Engine
 */
export class TestRunner {
  constructor() {
    this.tests = [];
    this.results = [];
  }

  register(tier, milestone, feature, name, fn) {
    this.tests.push({
      tier,
      milestone,
      feature,
      name,
      fn
    });
  }

  async run(filterOptions = {}) {
    const { tier, milestone, feature, bail = false } = filterOptions;
    let selected = this.tests;

    if (tier) {
      selected = selected.filter(t => String(t.tier) === String(tier));
    }
    if (milestone) {
      selected = selected.filter(t => t.milestone.toLowerCase() === milestone.toLowerCase());
    }
    if (feature) {
      selected = selected.filter(t => t.feature.toLowerCase() === feature.toLowerCase());
    }

    this.results = [];
    for (const t of selected) {
      const start = Date.now();
      try {
        await t.fn();
        const durationMs = Date.now() - start;
        this.results.push({
          ...t,
          status: "PASS",
          durationMs,
          error: null
        });
      } catch (err) {
        const durationMs = Date.now() - start;
        this.results.push({
          ...t,
          status: "FAIL",
          durationMs,
          error: err
        });
        if (bail) break;
      }
    }
    return this.results;
  }
}

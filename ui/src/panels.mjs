// Server-side panel runs: generate personas, gather shared material once, run each round with bounded
// concurrency, then a moderator summary. Runs survive window reloads and are saved to disk as they go.
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR, STATE_DIR, WORKTREES_DIR } from "./config.mjs";
import { broadcastEvent } from "./events.mjs";
import {
  MAX_PANELISTS,
  MAX_ROUNDS,
  PANEL_MODES,
  averageRating,
  digestAnswers,
  formatTallyMarkdown,
  moderatorMessages,
  panelRoundPrompt,
  panelistSystemPrompt,
  parsePersonaList,
  personaGenerationMessages,
  tallyVotes
} from "./panel-core.mjs";
import { queryModelWithRetry, resolveAgentModel } from "./session-runner.mjs";
import { isPathInside } from "./util.mjs";

export const PANELS_DIR = path.join(STATE_DIR, ".vanaras-panels");
const activePanels = new Map();

const MATERIAL_CHARS = 20000;
const MATERIALS_TOTAL_CHARS = 48000;

function writeRunFile(run) {
  try {
    fs.mkdirSync(PANELS_DIR, { recursive: true });
    const file = path.join(PANELS_DIR, `${run.runId}.json`);
    const { abortController, ...data } = run;
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(`${file}.tmp`, file);
  } catch (e) {
    console.warn("Could not save panel run:", e.message);
  }
}

function modelFor(botId) {
  const { provider, baseUrl, model, apiKey } = resolveAgentModel(botId);
  return { provider, baseUrl, model, apiKey, botId };
}

// Thinking models (e.g. local reasoning models) spend part of max_tokens reasoning before they answer; with
// a tight budget the visible answer comes back empty. Budgets below leave room for that, and an empty answer
// gets one retry with double the budget and a nudge to answer directly.
async function ask(llm, messages, { temperature, max_tokens, signal }) {
  const res = await queryModelWithRetry({ ...llm, messages, temperature, max_tokens, enableReasoning: false, signal });
  const content = String(res?.content || "").trim();
  if (content || signal?.aborted) return content;
  const retry = await queryModelWithRetry({
    ...llm,
    messages: [...messages, { role: "user", content: "Reply now with only your final answer, in the requested format. Keep any reasoning very short." }],
    temperature,
    max_tokens: max_tokens * 2,
    enableReasoning: false,
    signal
  });
  return String(retry?.content || "").trim();
}

export async function generatePersonas({ brief, count, modelBotId = "bot_r1" }) {
  const n = Math.max(1, Math.min(MAX_PANELISTS, Number(count) || 5));
  const text = await ask(modelFor(modelBotId), personaGenerationMessages(String(brief || "").slice(0, 1000), n), { temperature: 0.9, max_tokens: Math.min(12000, 1500 + 300 * n) });
  const personas = parsePersonaList(text, n);
  if (personas.length === 0) throw new Error("The model did not return any usable personas. Try again or add panelists by hand.");
  return personas;
}

// Material is read once per run so every panelist judges exactly the same input.
async function readMaterial(item) {
  const kind = item?.type;
  if (kind === "text") {
    return `### ${item.label || "Text"}\n${String(item.text || "").slice(0, MATERIAL_CHARS)}`;
  }
  if (kind === "file") {
    const raw = String(item.path || "").trim();
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ROOT_DIR, raw);
    if (!isPathInside(abs, ROOT_DIR) && !isPathInside(abs, WORKTREES_DIR)) {
      return `### ${raw}\n(skipped: outside the project and agent worktrees)`;
    }
    if (!fs.existsSync(abs)) return `### ${raw}\n(not found)`;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter(e => !e.name.startsWith(".") && e.name !== "node_modules")
        .slice(0, 200)
        .map(e => (e.isDirectory() ? `${e.name}/` : e.name));
      return `### ${raw} (folder listing)\n${entries.join("\n")}`;
    }
    const body = fs.readFileSync(abs, "utf8");
    return `### ${raw}\n${body.length > MATERIAL_CHARS ? `${body.slice(0, MATERIAL_CHARS)}\n…(truncated, ${body.length} chars)` : body}`;
  }
  if (kind === "url") {
    let url;
    try { url = new URL(String(item.url || "")); } catch { return `### ${item.url}\n(invalid URL)`; }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      return `### ${item.url}\n(skipped: only pages served on this machine can be reviewed)`;
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      const type = res.headers.get("content-type") || "";
      let body = await res.text();
      if (type.includes("html")) {
        body = body
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/[ \t]+/g, " ")
          .replace(/\n\s*\n+/g, "\n");
      }
      return `### ${item.url} (HTTP ${res.status}, page text)\n${body.trim().slice(0, MATERIAL_CHARS)}`;
    } catch (e) {
      return `### ${item.url}\n(could not load: ${e.message})`;
    }
  }
  return "";
}

async function gatherMaterials(materials = []) {
  const parts = [];
  let total = 0;
  for (const item of materials) {
    const block = await readMaterial(item);
    if (!block) continue;
    if (total + block.length > MATERIALS_TOTAL_CHARS) {
      parts.push(`### ${item.path || item.url || item.label || "material"}\n(omitted: the shared material limit was reached)`);
      continue;
    }
    total += block.length;
    parts.push(block);
  }
  return parts.join("\n\n");
}

async function mapWithLimit(items, limit, fn, signal) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !signal.aborted) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

function publicRun(run) {
  const { abortController, ...data } = run;
  return data;
}

function emitStatus(run) {
  run.updatedAt = new Date().toISOString();
  broadcastEvent("panel_status", {
    runId: run.runId,
    threadId: run.threadId,
    status: run.status,
    round: run.round,
    rounds: run.rounds,
    answered: run.answeredThisRound,
    total: run.panelists.length,
    error: run.error || ""
  });
}

function addMessage(run, message) {
  run.messages.push(message);
  broadcastEvent("panel_message", { runId: run.runId, threadId: run.threadId, message });
  writeRunFile(run);
}

export function startPanelRun({ threadId, topic, mode = "debate", rounds = 1, panelists = [], options = [], materials = [], modelBotId = "bot_r1", concurrency = 3 }) {
  if (!threadId) throw new Error("threadId is required");
  if (!String(topic || "").trim()) throw new Error("A topic or question is required");
  if (!PANEL_MODES.includes(mode)) throw new Error(`mode must be one of ${PANEL_MODES.join(", ")}`);
  const seated = (Array.isArray(panelists) ? panelists : [])
    .map((p, i) => ({
      id: String(p.id || `p${i + 1}`),
      name: String(p.name || `Panelist ${i + 1}`).slice(0, 60),
      persona: String(p.persona || "").slice(0, 1200),
      botId: p.botId ? String(p.botId) : ""
    }))
    .filter(p => p.persona || p.botId);
  if (seated.length === 0) throw new Error("Add at least one panelist");
  if (seated.length > MAX_PANELISTS) throw new Error(`A panel can seat at most ${MAX_PANELISTS} panelists`);
  const cleanOptions = (Array.isArray(options) ? options : [])
    .map(o => ({ label: String(o.label || "").slice(0, 80), text: String(o.text || "").slice(0, 8000) }))
    .filter(o => o.text.trim());
  if (mode === "vote" && cleanOptions.length < 2) throw new Error("A/B voting needs at least two options");

  for (const run of activePanels.values()) {
    if (run.threadId === threadId && (run.status === "running" || run.status === "summarizing")) {
      run.abortController.abort();
      run.status = "stopped";
      emitStatus(run);
    }
  }

  const run = {
    runId: `panel_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    threadId,
    topic: String(topic).slice(0, 4000),
    mode,
    rounds: Math.max(1, Math.min(MAX_ROUNDS, Number(rounds) || 1)),
    concurrency: Math.max(1, Math.min(8, Number(concurrency) || 3)),
    modelBotId,
    panelists: seated,
    options: cleanOptions,
    materials,
    round: 0,
    answeredThisRound: 0,
    status: "running",
    messages: [],
    tally: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    abortController: new AbortController()
  };
  activePanels.set(run.runId, run);
  writeRunFile(run);
  executePanel(run).catch(err => {
    run.status = run.abortController.signal.aborted ? "stopped" : "error";
    run.error = err.message;
    emitStatus(run);
    writeRunFile(run);
  });
  return publicRun(run);
}

async function executePanel(run) {
  const signal = run.abortController.signal;
  emitStatus(run);
  const materialsText = await gatherMaterials(run.materials);
  run.materialsChars = materialsText.length;
  const panelModel = modelFor(run.modelBotId);
  let latest = [];

  for (let round = 1; round <= run.rounds && !signal.aborted; round++) {
    run.round = round;
    run.answeredThisRound = 0;
    emitStatus(run);
    const previous = latest;
    const answers = new Array(run.panelists.length);
    await mapWithLimit(run.panelists, run.concurrency, async (p, i) => {
      const prompt = panelRoundPrompt({
        mode: run.mode,
        topic: run.topic,
        options: run.options,
        materialsText,
        round,
        rounds: run.rounds,
        othersDigest: round > 1 ? digestAnswers(previous, { excludeName: p.name }) : ""
      });
      let text;
      try {
        // Existing agents keep their own model; generated personas use the panel's model.
        text = await ask(p.botId ? modelFor(p.botId) : panelModel, [
          { role: "system", content: panelistSystemPrompt(p, run.panelists.length) },
          { role: "user", content: prompt }
        ], { temperature: 0.8, max_tokens: 2000, signal });
      } catch (err) {
        if (signal.aborted) return;
        text = `(No answer: ${err.message})`;
      }
      if (signal.aborted) return;
      answers[i] = { name: p.name, text };
      run.answeredThisRound++;
      addMessage(run, {
        id: `msg_${run.runId}_r${round}_${p.id}`,
        senderType: "bot",
        panelist: { id: p.id, name: p.name, botId: p.botId },
        panelRunId: run.runId,
        round,
        text: text || "(empty answer)",
        timestamp: new Date().toISOString()
      });
      emitStatus(run);
    }, signal);
    latest = answers.filter(Boolean);
  }
  if (signal.aborted) {
    run.status = "stopped";
    emitStatus(run);
    writeRunFile(run);
    return;
  }

  const tally = run.mode === "vote" ? tallyVotes(latest, run.options) : null;
  const rating = run.mode === "review" ? averageRating(latest) : null;
  run.tally = tally;
  run.rating = rating;
  run.status = "summarizing";
  emitStatus(run);
  const transcript = digestAnswers(latest, { budgetChars: 30000 });
  let summary;
  try {
    summary = await ask(panelModel, moderatorMessages({ mode: run.mode, topic: run.topic, options: run.options, materialsText, transcript, tally, rating }), { temperature: 0.3, max_tokens: 4000, signal });
  } catch (err) {
    if (signal.aborted) throw err;
    summary = `(The moderator could not summarise: ${err.message})`;
  }
  const header = tally
    ? `**Panel result** — ${run.panelists.length} panelists, ${run.rounds} round${run.rounds > 1 ? "s" : ""}\n\n${formatTallyMarkdown(tally, run.options)}\n\n`
    : rating
      ? `**Panel result** — ${run.panelists.length} panelists · average rating **${rating.average.toFixed(1)}/10** (${rating.count} rated)\n\n`
      : `**Panel result** — ${run.panelists.length} panelists, ${run.rounds} round${run.rounds > 1 ? "s" : ""}\n\n`;
  addMessage(run, {
    id: `msg_${run.runId}_summary`,
    senderType: "bot",
    panelist: { id: "moderator", name: "Moderator" },
    panelRunId: run.runId,
    isPanelSummary: true,
    text: `${header}${summary}`,
    timestamp: new Date().toISOString()
  });
  run.status = "completed";
  emitStatus(run);
  writeRunFile(run);
}

export function stopPanels({ threadId = "", runId = "" } = {}) {
  let stopped = 0;
  for (const run of activePanels.values()) {
    if (run.status !== "running" && run.status !== "summarizing") continue;
    if (runId && run.runId !== runId) continue;
    if (threadId && run.threadId !== threadId) continue;
    run.abortController.abort();
    run.status = "stopped";
    emitStatus(run);
    writeRunFile(run);
    stopped++;
  }
  return stopped;
}

// Runs in memory (this server process), or a saved run by id after a restart.
export function listPanelRuns({ threadId = "", runId = "" } = {}) {
  if (runId) {
    const live = activePanels.get(runId);
    if (live) return [publicRun(live)];
    try {
      return [JSON.parse(fs.readFileSync(path.join(PANELS_DIR, `${path.basename(runId)}.json`), "utf8"))];
    } catch {
      return [];
    }
  }
  return Array.from(activePanels.values())
    .filter(r => !threadId || r.threadId === threadId)
    .map(publicRun);
}

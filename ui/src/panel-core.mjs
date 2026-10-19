// Panel semantics with no I/O: modes, prompts, persona parsing and vote tallying. A panel is a topic put to
// any number of persona "panelists" (debate, A/B vote or review), then summarised by a moderator.

export const PANEL_MODES = ["debate", "vote", "review"];
export const MAX_PANELISTS = 100;
export const MAX_ROUNDS = 4;

const OPTION_LETTERS = "ABCDEFGHIJ";

export function optionLetter(i) {
  return OPTION_LETTERS[i] || String(i + 1);
}

// The persona generator answers in JSON, but local models wrap it in prose or code fences, and sometimes
// fall back to a "Name — description" list. Accept both; keep names unique.
export function parsePersonaList(text, count = MAX_PANELISTS) {
  const raw = String(text || "");
  let items = [];
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (Array.isArray(parsed)) items = parsed;
    } catch {}
  }
  if (items.length === 0) {
    for (const line of raw.split("\n")) {
      const m = /^\s*(?:[-*•]|\d+[.)])?\s*\**([^*:—–\-|]{2,60}?)\**\s*(?:—|–|-|:|\|)\s*(.{10,})$/.exec(line);
      if (m) items.push({ name: m[1], persona: m[2] });
    }
  }
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const name = String(it?.name || "").trim().replace(/\s+/g, " ").slice(0, 60);
    const persona = String(it?.persona || it?.description || it?.profile || "").trim().slice(0, 600);
    if (!name || !persona || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, persona });
    if (out.length >= count) break;
  }
  return out;
}

export function personaGenerationMessages(brief, count) {
  return [
    {
      role: "system",
      content: "You create realistic, varied audience personas for research panels. Reply with JSON only."
    },
    {
      role: "user",
      content: `Create ${count} distinct people who belong to this audience:\n"${brief}"\n\nVary age, background, tastes, expertise and attitude (include skeptics and enthusiasts). For each give a first name with a last initial and a 1-2 sentence persona describing who they are and what they care about.\nReply with a JSON array only: [{"name": "Maya R.", "persona": "..."}]`
    }
  ];
}

export function panelistSystemPrompt(panelist, panelSize) {
  return `You are ${panelist.name}. ${panelist.persona}
You are one of ${panelSize} people on a panel. Stay in character: answer from this person's own experience, tastes and priorities, in their voice. Do not describe yourself as an AI or an assistant. Be honest, specific and concise (under 150 words).`;
}

function optionsBlock(options) {
  return options.map((o, i) => `Option ${optionLetter(i)}${o.label && o.label !== optionLetter(i) ? ` (${o.label})` : ""}:\n${o.text}`).join("\n\n");
}

function materialsBlock(materialsText) {
  return materialsText ? `\n\nMaterial to consider:\n${materialsText}` : "";
}

const FINAL_LINE = {
  debate: "End with one line: POSITION: <your position in one sentence>",
  vote: "End with one line: VOTE: <option letter>",
  review: "End with one line: RATING: <1-10>"
};

// Round 1 is independent (no anchoring on others); later rounds show what the rest of the panel said.
export function panelRoundPrompt({ mode, topic, options = [], materialsText = "", round, rounds, othersDigest = "" }) {
  const head = mode === "vote"
    ? `Question: ${topic}\n\n${optionsBlock(options)}${materialsBlock(materialsText)}`
    : mode === "review"
      ? `Review this as yourself: ${topic}${materialsBlock(materialsText)}`
      : `Topic for discussion: ${topic}${materialsBlock(materialsText)}`;
  const ask = round === 1
    ? (mode === "vote"
      ? "Which option do you prefer, and why? Say what would change your mind."
      : mode === "review"
        ? "What works for you, what doesn't, and what would you change? Be concrete."
        : "What is your position, and what reasons matter most to you?")
    : `This is round ${round} of ${rounds}. Here is what other panelists said:\n${othersDigest}\n\nRespond to the points that matter to you. Keep, change or refine your view, and say why.`;
  return `${head}\n\n${ask}\n${FINAL_LINE[mode] || FINAL_LINE.debate}`;
}

// Reads the closing "VOTE: B" / "POSITION: ..." / "RATING: 7" line (the last one wins).
export function parseMarker(text, marker) {
  const rx = new RegExp(`^\\s*\\**${marker}\\**\\s*[:=-]\\s*(.+?)\\s*$`, "gim");
  let m;
  let last = null;
  while ((m = rx.exec(String(text || ""))) !== null) last = m[1].replace(/\*+/g, "").trim();
  return last;
}

// Maps a VOTE value to an option index: "B", "Option B", "b)", or the option's label text.
export function resolveVote(value, options) {
  if (!value) return -1;
  const v = String(value).trim();
  const letter = /^(?:option\s+)?([A-J])\b/i.exec(v);
  if (letter) {
    const idx = OPTION_LETTERS.indexOf(letter[1].toUpperCase());
    if (idx >= 0 && idx < options.length) return idx;
  }
  const lower = v.toLowerCase();
  return options.findIndex(o => o.label && lower.includes(String(o.label).toLowerCase()));
}

// The tally is computed here, not by the moderator model, so the numbers are exact.
export function tallyVotes(answers, options) {
  const counts = options.map(() => 0);
  const voters = options.map(() => []);
  const unclear = [];
  for (const a of answers) {
    const idx = resolveVote(parseMarker(a.text, "VOTE"), options);
    if (idx >= 0) {
      counts[idx]++;
      voters[idx].push(a.name);
    } else {
      unclear.push(a.name);
    }
  }
  return { counts, voters, unclear, total: answers.length };
}

export function averageRating(answers) {
  const ratings = answers
    .map(a => Number.parseFloat(parseMarker(a.text, "RATING")))
    .filter(n => Number.isFinite(n) && n >= 0 && n <= 10);
  if (ratings.length === 0) return null;
  return { average: ratings.reduce((s, n) => s + n, 0) / ratings.length, count: ratings.length };
}

export function formatTallyMarkdown(tally, options) {
  const rows = options.map((o, i) => {
    const pct = tally.total ? Math.round((tally.counts[i] / tally.total) * 100) : 0;
    return `| ${optionLetter(i)}${o.label && o.label !== optionLetter(i) ? ` — ${o.label}` : ""} | ${tally.counts[i]} | ${pct}% |`;
  });
  const unclear = tally.unclear.length ? `\n\nNo clear vote: ${tally.unclear.length} (${tally.unclear.join(", ")})` : "";
  return `| Option | Votes | Share |\n|---|---|---|\n${rows.join("\n")}${unclear}`;
}

// What each panelist said in the latest round, shortened so a large panel still fits in one prompt.
export function digestAnswers(answers, { excludeName = "", budgetChars = 12000 } = {}) {
  const others = answers.filter(a => a.name !== excludeName);
  if (others.length === 0) return "(no other answers)";
  const per = Math.max(160, Math.min(700, Math.floor(budgetChars / others.length)));
  const lines = others.map(a => {
    const t = String(a.text || "").replace(/\s+/g, " ").trim();
    return `- ${a.name}: ${t.length > per ? `${t.slice(0, per)}…` : t}`;
  });
  let out = "";
  let shown = 0;
  for (const l of lines) {
    if (out.length + l.length > budgetChars) break;
    out += `${l}\n`;
    shown++;
  }
  return shown < lines.length ? `${out}(… and ${lines.length - shown} more panelists)` : out.trimEnd();
}

export function moderatorMessages({ mode, topic, options = [], materialsText = "", transcript, tally = null, rating = null }) {
  const facts = mode === "vote" && tally
    ? `\n\nVote tally (already counted; use these numbers as they are):\n${formatTallyMarkdown(tally, options)}`
    : mode === "review" && rating
      ? `\n\nAverage rating: ${rating.average.toFixed(1)}/10 from ${rating.count} panelists.`
      : "";
  const task = mode === "vote"
    ? "Report the winner using the tally above. Explain the main reasons people chose each option, which kinds of people preferred which, and what would most likely flip the losing side."
    : mode === "review"
      ? "Merge the reviews into a prioritised list of issues and strengths. For each, say how many panelists raised it and quote one short example. Finish with the top three changes to make."
      : "Give the panel's final answer. State where the panel agreed, the main disagreements and why, and any minority view worth keeping.";
  return [
    {
      role: "system",
      content: "You are the moderator of a research panel. Summarise faithfully: never invent opinions, numbers or quotes that are not in the transcript. Write for the person who ran the panel; do not repeat these instructions."
    },
    {
      role: "user",
      content: `${mode === "vote" ? `Question: ${topic}\n\n${optionsBlock(options)}` : `Topic: ${topic}`}${materialsText ? "\n\n(The panel reviewed shared material.)" : ""}${facts}\n\nTranscript:\n${transcript}\n\n${task}\nUse short sections with headings.`
    }
  ];
}

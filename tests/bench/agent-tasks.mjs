// Tasks for tests/bench/agent-ab-bench.mjs. "answer" tasks are checked against the agent's final answer;
// "edit" tasks are checked by running a verifier against the agent's worktree after the turn.
// Every check encodes the true answer in this repository; update it if the code it describes changes.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Agents may edit the file in the worktree root or in their agent_workspace copy; accept either.
function findEdited(roots, rel) {
  return roots.map(r => path.join(r, rel)).filter(p => fs.existsSync(p));
}

export const TASKS = [
  {
    id: "retry",
    kind: "answer",
    question: "When a model request fails, how many times is it retried by default, and how long does it wait between attempts? Name the file and the function.",
    check: a => /queryModelWithRetry/.test(a) && /session-runner/.test(a)
  },
  {
    id: "approval",
    kind: "answer",
    question: "Which HTTP endpoint does the UI call to approve or deny a pending agent command, and how long does the agent wait for an answer before giving up? Name the files involved.",
    check: a => /\/api\/approvals\/respond/.test(a) && /\b60\b|60\s*s|60,?000|sixty/i.test(a)
  },
  {
    id: "vote",
    kind: "answer",
    question: "In a panel's A/B vote, how does the code decide which option a panelist's vote refers to? Name the file and function.",
    check: a => /resolveVote/.test(a) && /panel-core/.test(a)
  },
  {
    id: "deny",
    kind: "answer",
    question: "Which function decides that a shell command is too destructive to ever run, and what does the agent get back when it tries one? Name the file.",
    check: a => /checkCommandPermission/.test(a) && /security/.test(a) && /permission denied|deny|denied/i.test(a)
  },
  {
    id: "killtree",
    kind: "answer",
    question: "How does the server stop a running command together with all of its child processes? Name the file and function, and say what it signals.",
    check: a => /killProcessTree|signalProcessTree/.test(a) && /process\.mjs|process group|-pid|negative/i.test(a)
  },
  {
    id: "keys",
    kind: "answer",
    question: "Where are API keys saved on disk, and with what file permissions? Name the file name and the function that writes it.",
    check: a => /\.vanaras-keys\.json|saveLocalKeysVault/.test(a) && /0o?600|\b600\b|rw-------|owner[- ]only/i.test(a)
  },
  {
    id: "panelmax",
    kind: "answer",
    question: "What is the maximum number of panelists a panel can seat, and where is that limit defined?",
    check: a => /\b100\b/.test(a) && /MAX_PANELISTS|panel-core/.test(a)
  },
  {
    id: "embed",
    kind: "answer",
    question: "Which embedding model does code_search use by default, and how many vector dimensions does it keep per chunk?",
    check: a => /embeddinggemma-2/i.test(a) && /\b256\b/.test(a)
  },
  {
    id: "loopback",
    kind: "answer",
    question: "Which requests does the server refuse based on their Host or Origin header, and which function enforces it?",
    check: a => /enforceLocalRequestBoundary/.test(a) && /loopback|localhost|127\.0\.0\.1/i.test(a)
  },
  {
    id: "freshpage",
    kind: "answer",
    question: "When the web page is opened in a fresh browser, what stops it from saving its default state over the saved workspace? Name the variable or function responsible.",
    check: a => /workspaceLoadedFromServer/.test(a)
  },
  {
    id: "slugify",
    kind: "edit",
    question: "Add an exported function slugifyTitle(text) to ui/src/util.mjs. It must lowercase the text, replace every run of characters that are not a-z or 0-9 with a single hyphen, and remove leading and trailing hyphens. Do not change anything else.",
    verify: roots => {
      for (const file of findEdited(roots, "ui/src/util.mjs")) {
        try {
          const out = execFileSync(process.execPath, ["--input-type=module", "-e",
            `const m = await import(${JSON.stringify(`file://${file}`)}); const f = m.slugifyTitle;` +
            `const cases = [["  Hello, World!  ", "hello-world"], ["A--B__c", "a-b-c"], ["Ship v2.0 now", "ship-v2-0-now"], ["---", ""]];` +
            `console.log(cases.every(([i, o]) => f(i) === o) ? "PASS" : "FAIL " + JSON.stringify(cases.map(([i]) => f(i))));`
          ], { timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
          if (out === "PASS") return { ok: true, detail: file };
        } catch {}
      }
      return { ok: false, detail: "slugifyTitle missing or wrong" };
    }
  },
  {
    id: "maxfile",
    kind: "edit",
    question: "The code search index skips files above a size limit. Raise that limit from 400 KB to 512 KB. Change only that limit.",
    verify: roots => {
      for (const file of findEdited(roots, "ui/src/code-index.mjs")) {
        const src = fs.readFileSync(file, "utf8");
        if (/MAX_FILE_BYTES\s*=\s*(?:512\s*\*\s*1024|524288)\b/.test(src) && !/400\s*\*\s*1024/.test(src)) return { ok: true, detail: file };
      }
      return { ok: false, detail: "limit not changed to 512 KB in ui/src/code-index.mjs" };
    }
  }
];

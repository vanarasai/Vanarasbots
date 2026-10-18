# Vanaras improvement plan

**Date:** 2026-10-18 · **Basis:** [agent-report-review.md](agent-report-review.md) (verified claims and
measurements) and the issues found while fixing agent reliability on branch `fix/agent-turn-continuity`
(PR #1). Every item cites its evidence. Nothing here relies on the unverified agent reports.

## Where Vanaras stands

Vanaras already has multi-agent rooms, hand-offs, parallel @mentions, panels that debate and vote, subagents,
shared and per-agent memory, and agents that write, edit, run and verify code. Since PR #1, each room works on its
own project repository, agents are confined to their branch of it, and hybrid `code_search` is on by default.

What is missing is **structure, safety and proof**: work is coordinated by conversation rather than tasks, the local
API trusts any process on the machine, and agents can report work that never happened.

## Priorities

| # | Item | Why (evidence) | Size |
|---|---|---|---|
| 1 | Lock the control API | Agents' shell commands can call the server and approve their own commands | S |
| 2 | Keep secrets out of agent processes | Agents inherit the server's API keys | S |
| 3 | Claims must cite proof | An agent reported creating files whose writes all failed | M |
| 4 | Review, then merge (diff view) | Merge exists; reviewing an agent's branch in the app does not | M |
| 5 | Task model for coordination | No tasks, owners, dependencies or status | L |
| 6 | Memory with history | Shared and per-agent memory keep current state only | M |
| 7 | One agent runtime | Browser-side loop and unused Rust crates duplicate the server runner | M |
| 8 | Safer workspace storage | One JSON file rewritten whole by every window and turn | M |
| 9 | Measure every change | Single-run benchmarks cannot separate BM25 from hybrid | S |

Items 1-3 come first: they decide whether anything agents do can be trusted. Items 4-6 deliver the coordination the
team asked about. Items 7-9 reduce cost and risk for everything after.

---

### 1. Lock the control API

- **Evidence:** `enforceLocalRequestBoundary` (`ui/src/security.mjs:119`) checks only that a request comes from this
  machine (Host and Origin headers). Any local process can call it, including an agent's own `shell_exec`, which can
  then run commands through `/api/workspace/exec` or answer its own `/api/approvals/respond`.
- **Change:** the server creates a secret token at startup that only the UI, CLI and macOS app receive. Every API call
  must carry it, and agent processes never get it.
- **Done when:** an end-to-end test shows an agent's `curl` to the API is refused, while the UI and CLI still work.

### 2. Keep secrets out of agent processes

- **Evidence:** `buildAgentExecEnv` starts from `...process.env` (`ui/src/env.mjs:64`), so every command an agent runs
  can read `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` and others.
- **Change:** build agent environments from an allowlist (PATH, HOME, locale, the venv) and drop credential variables.
- **Done when:** a test running `env` as an agent shows no keys; existing agent tasks still pass.

### 3. Claims must cite proof

- **Evidence:** the agent *van* reported "implementing" `tool_registry.rs` and `agent_manager.rs` while every write
  failed (`Unknown agent tool: write_file`). Its later reports cited those files as evidence
  ([review](agent-report-review.md), "How the false evidence arose").
- **Change:**
  - When a final answer says files were created, changed or tested, the runner checks those claims against the
    turn's successful tool calls, and flags any it cannot match in the message.
  - Reports produced for people (plans, reviews, comparisons) link every claim to a file and line or to a tool output.
  - The per-message Steps panel (added in PR #1) already shows the tool calls; this makes them the reference.
- **Done when:** a test replays van's failed turn and the answer is flagged; the A/B harness counts flagged claims per
  setup.

### 4. Review, then merge

- **Evidence:** merging is a real `git merge` into the room's project since PR #1 (`merge_to_main` in
  `ui/src/routes/agent-workspace.mjs`), but the app has no view of what an agent's branch changes before you merge.
- **Change:** per agent, show the diff of its branch against the project's current branch, with commit list, files
  changed and test status; Merge sits next to it. Conflicts are shown, never auto-resolved.
- **Done when:** in the macOS app, a branch with changes shows its diff, and Merge brings exactly that diff in.

### 5. Task model for coordination

- **Evidence:** no task queue, scheduler or dependencies anywhere (review row 14). Coordination today is by @mentions,
  `[HANDOFF]` tags and relay order (rows 9-10), which cannot express "B waits for A" or "these three can run at once".
- **Change:**
  - A task has a title, owner (agent), status (`todo`, `running`, `blocked`, `done`, `failed`), dependencies, and
    evidence of completion (its tool calls, the commit on the agent's branch, test results).
  - The room's lead turns a request into tasks; the server runs independent tasks in parallel (per-agent server turns
    already run concurrently since PR #1) and starts dependent ones when their inputs are done.
  - Tasks are visible in the room and survive reloads, like server turns.
- **Done when:** a three-step request (e.g. "add an endpoint, write its test, update the docs") runs as three tasks,
  the independent ones in parallel, and each task shows its proof.

### 6. Memory with history

- **Evidence:** shared rules (`ui/index.html:4351`) and per-agent memory (`ui/src/agent-store.mjs:28`) store current
  state only (review row 12). There is no record of who added or changed a fact, or when.
- **Change:** an append-only log of memory changes (fact, author, time, source message or task); the current view is
  derived from it; any earlier state can be shown or restored.
- **Done when:** removing a fact keeps it in history, and the room can show memory as of a given task.

### 7. One agent runtime

- **Evidence:** every agent now runs on the server runner, but the browser-side loop is still in the page
  (`ui/index.html:5697`, behind `useServerRunner !== false` at `:5556`). The Rust crates in `crates/` are not used by
  the app at all.
- **Change:** delete the browser-side loop and its prompt-repair code. Archive or delete the Rust crates unless there
  is a plan to use them.
- **Done when:** the page has no agent loop; behaviour and tests are unchanged; the repo states what the crates are
  for, or no longer has them.

### 8. Safer workspace storage

- **Evidence:** all rooms live in one JSON file that every window and server turn rewrites whole
  (`ui/src/workspace-state.mjs:51`). A fresh page once overwrote the whole workspace this way (fixed in PR #1, but the
  design still allows lost updates between windows).
- **Change:** store rooms separately, write atomically (temporary file, then rename), and merge by message id rather
  than replacing the whole file.
- **Done when:** two windows and a server turn writing at once lose no messages, in a test.

### 9. Measure every change

- **Evidence:** the agent A/B completed one repeat before its server dropped (12 tasks: grep 3, BM25 5, hybrid 6
  solved), which cannot separate BM25 from hybrid. During that run Ollama loaded `qwen3:14b` with a 4,096-token
  context, smaller than many prompts, so long prompts were cut.
- **Change:** run `tests/bench/agent-ab-bench.mjs` with 3 or more repeats on an idle machine, with a larger Ollama
  context; add tasks from real room work; keep each report in the repo so results can be compared across releases.
- **Done when:** a report with repeats shows whether hybrid beats BM25 by more than the run-to-run spread.

## Small fixes to fold in

- **Case-insensitive paths:** `isPathInside` (`ui/src/util.mjs:21`) compares paths as text, so on macOS
  `/users/...` and `/Users/...` (the same folder) are treated as different, and agents get confusing refusals.
  Compare real paths.
- **Rooms still on the Vanaras folder:** existing rooms point at Vanaras's own code and ask for confirmation before
  agents run; offer a one-click "choose project" for them.

## Not planned

- **Inline (editor-style) code completion.** Vanaras is not an editor, and agents already write and edit whole files.
  Revisit only if Vanaras gains an editor surface.
- **A GrokBots-style manager/worker/specialist hierarchy for its own sake.** Items 5 and 6 address the real
  coordination gaps; roles can be added to tasks if the task model shows the need.

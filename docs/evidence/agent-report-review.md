# Review of the agent-written architecture reports

**Reviewed:** `docs/agent-reports/architecture_improvement_plan.md` and `docs/agent-reports/evidence_report.md`
(written by the agent *van* on 2026-10-18; the reports themselves say "2026-04-10").
**Method:** every factual claim checked against the code at commit `3b2b4fc` (branch `fix/agent-turn-continuity`)
and against measurements taken on 2026-10-17/18. Line numbers refer to that commit.

## Verdict

The reports should not be shared as evidence. Their two central "evidence" files do not exist, their main
conclusion (Vanaras is a single-agent CLI with no collaboration or shared memory) is contradicted by the code,
and the GrokBots comparison has no source.

Of 20 checked claims:

- **Correct:** 7, mostly small facts about the CLI.
- **Partly correct:** 2 (agent hierarchy, tool discovery).
- **Wrong:** 9, including every claim the plan's roadmap is built on.
- **Unverifiable or not evidence:** 2 (the GrokBots column, and the success-metric targets).

## How the false evidence arose

In an earlier turn (room *van*, "whats missing between them and grokbots?"), the agent reported that it had
"implemented" `vanaras/core/tool_registry.rs` and `vanaras/core/agent_manager.rs`. Every write in that turn failed
with `Unknown agent tool: write_file`; neither file was ever created. Its reasoning also records that GrokBots
"is not currently part of the Vanaras codebase" and describes GrokBots features "from my knowledge". The later
reports then cite those non-existent files, and that unsourced description, as evidence.

## Claim by claim

| # | Claim in the reports | Verdict | Evidence |
|---|---|---|---|
| 1 | `vanaras/core/agent_manager.rs` keeps a flat list of agents with no task logic | **Wrong — file does not exist** | No `agent_manager` or `tool_registry` file anywhere in the repo (`git ls-files`). The Rust crates are `crates/vanaras-{core,agent,mcp,relay,cli}`, and the running app does not use them (no import from `ui/`). |
| 2 | `vanaras/core/tool_registry.rs` defines tools as a static array | **Wrong — file does not exist** | As above. The real static list is `VANARAS_NATIVE_TOOLS` in `ui/src/native-tools.mjs:3`. |
| 3 | `vanaras-cli.mjs` is the sole / main entry point ("monolithic CLI") | **Wrong** | The product is the HTTP server `ui/server.mjs` (about 45 API routes in `ui/src/routes/`), the web UI `ui/index.html`, and the macOS app `macos/main.m`. The CLI is one small client of the server. |
| 4 | CLI commands are `status`, `diff`, `search`, `ask` | Correct | `vanaras-cli.mjs:400-409`. |
| 5 | CLI functions `parseCliArgs`, `normalizeBotId`, `handleStatus/Diff/Search/Ask` exist | Correct | `vanaras-cli.mjs:12, 19, 104, 175, 237, 289`. |
| 6 | `normalizeBotId` lowercases agent ids | Correct | `vanaras-cli.mjs:12-17` (also adds the `bot_` prefix). |
| 7 | The CLI's `ask` starts a fresh one-off session per call | Correct (for the CLI only) | `vanaras-cli.mjs:296` creates a new `cli_<timestamp>` thread each time. Rooms in the app keep history across turns. |
| 8 | No code generation; agents cannot write code ("no autonomous code completion") | **Wrong as stated** | Agents write and edit files and run them: `fs_write` (`ui/src/agent-tools.mjs:223`), `exact_edit` (`:244`), `===FILE===`/`===PATCH===` blocks, and a verify-and-retry loop (`ui/src/session-runner.mjs:365`). What does not exist is IDE-style inline completion (no completion engine in `ui/`). |
| 9 | No hand-offs between agents | **Wrong** | `[HANDOFF: @Name]` parsing (`ui/index.html:3673-3675`), automatic relay after server turns (`continueSquadAfterServerTurn`, `ui/index.html:5446`), squad relay order (`buildDynamicSquadRelay`, `:3290`). |
| 10 | Agents cannot message each other or work as a team; "single-agent only" | **Wrong** | Group rooms (`type: "group"`, `ui/index.html:2521`), parallel @mention dispatch (`:5154`), Collab debate and synthesis (`triggerGroupCollabRun`, `:6672`), panels with multi-round debate where each panelist sees the others (`ui/src/panel-core.mjs:79-91`). |
| 11 | No shared context store; the memory ledger "is mentioned but not implemented" | **Wrong** | Shared workspace rules are injected into every agent's prompt (`ui/index.html:4351`) and persisted with the workspace; per-agent memory is saved to disk (`saveAgentMemory`, `ui/src/agent-store.mjs:28`) and fed by `[REMEMBER: ...]` (`ui/src/session-runner.mjs:306`). |
| 12 | Shared memory has no versioning or snapshots | Correct | Memory is stored as current state only; nothing records versions. |
| 13 | Subagents are isolated, with no integration | **Wrong** | The lead spawns them (`ui/src/subagents.mjs:13`) and reads their results (`get_subagent_output`, `ui/src/agent-tools.mjs:781`). |
| 14 | No task queue, scheduler or task dependencies | Correct | No task graph or scheduler in `ui/src` or `crates/`. The only queues are a queue of pending prompts (`pendingBatchQueue`, `ui/index.html:5078`) and queued @mentions; neither models dependencies. |
| 15 | Agents have no hierarchy (no manager/worker roles) | Partly correct | No formal hierarchy type, but rooms have an implicit lead, reviewer and relay order (`buildDynamicSquadRelay`, `getSquadReviewerBot`), and `explore` and `plan` subagents get restricted, read-only tool sets enforced in `ui/src/security.mjs`. |
| 16 | Tools are manually registered; no auto-discovery | Mostly correct | Native tools are a static list (`ui/src/native-tools.mjs:3`). MCP servers are discovered on the host (`/api/mcp/discover`, `ui/src/routes/agent-tools.mjs:22`). |
| 17 | Agents are invoked individually via `/api/sessions/turn` | Correct, incomplete | True of each turn; rooms chain and parallelise those turns (rows 9-10). |
| 18 | GrokBots has a manager→worker hierarchy, task queues, inter-agent channels, versioned memory, integrated completion | **Unverifiable** | No source given. The agent's own notes say it described GrokBots "from my knowledge". |
| 19 | Success targets (≥10 tasks/hour, ≥85% completion accuracy, ≥4/5 satisfaction) | **Not evidence** | Targets with no baseline or measurement method. |
| 20 | Report timestamp "2026-04-10 08:30 UTC" | **Wrong** | Written 2026-10-18 at 10:37 local time (file times; the agent's conversation). |

## What we have actually measured

Evidence the team can rely on, with how it was produced.

| Question | Result | How measured |
|---|---|---|
| Does indexed search find the right code more often than grep? | Answer in the top 3: grep 0/12, keyword (BM25) 7/12, hybrid (BM25 + EmbeddingGemma 2) 9/12 | `node tests/bench/code-search-bench.mjs`: 12 questions about this repository with known answer locations; no model calls. |
| Does it help agents finish tasks? | Solved: grep 3/12, BM25 5/12, hybrid 6/12. Mean tokens per task 12.4k / 7.2k / 9.2k; mean time 211 s / 118 s / 128 s | `node tests/bench/agent-ab-bench.mjs` on local `qwen3:14b`, 12 tasks (10 questions, 2 code edits), first full repeat only (one run each). Not enough runs to separate BM25 from hybrid. |
| Does a multi-agent panel work on a real model? | 3 generated personas voted in character; tally 2-1 computed exactly; moderator summary matched the answers | One A/B panel on OpenRouter `meta/muse-spark-open`. |
| Are agents confined to their project? | Writes stay on the agent's branch until merged; reads outside the worktree and requests without a project are refused | Hermetic end-to-end tests (41 passing), against a fixture project. |

## Real gaps (confirmed)

These are the gaps the evidence supports, as a basis for a corrected plan:

1. **No task model.** Work is coordinated by conversation (mentions, hand-offs, relay order), not by tasks with owners, dependencies and status (rows 14-15).
2. **Memory has no history.** Shared and per-agent memory record current state only (row 12).
3. **No inline code completion.** Agents write whole files and edits; there is no editor-style completion (row 8).
4. **Native tools are a fixed list** (row 16).
5. **Evidence quality.** Agents can report work that never happened (the failed `tool_registry.rs` and `agent_manager.rs` writes). Reports need tool-call evidence attached, which the new per-message Steps panel now provides.

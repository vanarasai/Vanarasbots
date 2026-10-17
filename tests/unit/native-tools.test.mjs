import "./_env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { VANARAS_NATIVE_TOOLS, parseTextToolCalls, parseDeliverableBlocksText } from "../../ui/src/native-tools.mjs";

test("native tool schema: every tool is a well-formed OpenAI-compatible function definition", () => {
  assert.ok(VANARAS_NATIVE_TOOLS.length >= 15);
  const seen = new Set();
  for (const t of VANARAS_NATIVE_TOOLS) {
    assert.equal(t.type, "function");
    const fn = t.function;
    assert.match(fn.name, /^[a-z][a-z0-9_]*$/, `bad tool name ${fn.name}`);
    assert.ok(!seen.has(fn.name), `duplicate tool ${fn.name}`);
    seen.add(fn.name);
    assert.ok(fn.description && fn.description.length > 10, `${fn.name} needs a description`);
    assert.equal(fn.parameters.type, "object", `${fn.name} parameters must be an object schema`);
    for (const req of fn.parameters.required || []) {
      assert.ok(fn.parameters.properties && req in fn.parameters.properties, `${fn.name}: required "${req}" is not a declared property`);
    }
    for (const [prop, def] of Object.entries(fn.parameters.properties || {})) {
      assert.ok(def.type, `${fn.name}.${prop} needs a type`);
    }
  }
});

test("native tool schema: the advertised tool set matches the tools the executor and text fallback support", () => {
  const names = VANARAS_NATIVE_TOOLS.map(t => t.function.name);
  for (const expected of [
    "exact_edit", "fs_read", "fs_write", "shell_exec", "grep_search", "find_files", "start_process", "stop_process",
    "get_process_logs", "verify_project", "git_status", "git_diff", "git_commit", "spawn_subagent", "get_subagent_output",
    "list_subagents", "mcp_probe", "mcp_call"
  ]) {
    assert.ok(names.includes(expected), `missing native tool ${expected}`);
  }
});

test("text fallback: [TOOL: ...] tags map onto the same argument names the native schema declares", () => {
  const argNames = Object.fromEntries(VANARAS_NATIVE_TOOLS.map(t => [t.function.name, Object.keys(t.function.parameters.properties || {})]));
  const check = (text, tool, expectedKey) => {
    const [call] = parseTextToolCalls(text);
    assert.equal(call.tool, tool);
    assert.ok(argNames[tool].includes(expectedKey), `${tool} schema must declare "${expectedKey}"`);
    assert.ok(expectedKey in call.args, `${tool} fallback must emit "${expectedKey}"`);
    return call.args;
  };
  assert.equal(check("[TOOL: shell_exec | npm test]", "shell_exec", "command").command, "npm test");
  assert.equal(check("[TOOL: fs_read | src/a.py]", "fs_read", "filePath").filePath, "src/a.py");
  assert.equal(check("[TOOL: grep_search | ensureAgentWorktree]", "grep_search", "pattern").pattern, "ensureAgentWorktree");
  assert.equal(check("[TOOL: find_files | *.py]", "find_files", "query").query, "*.py");
  assert.equal(check("[TOOL: verify_project | pytest -q]", "verify_project", "command").command, "pytest -q");
  assert.equal(check("[TOOL: start_process | npm run dev]", "start_process", "command").command, "npm run dev");
  assert.equal(check("[TOOL: stop_process | proc_1]", "stop_process", "processId").processId, "proc_1");
  assert.equal(check("[TOOL: get_subagent_output | sub_x]", "get_subagent_output", "subagentId").subagentId, "sub_x");
  assert.equal(check("[TOOL: git_commit | feat: x]", "git_commit", "message").message, "feat: x");
});

test("text fallback: exact_edit and spawn_subagent use ||| separators", () => {
  const [edit] = parseTextToolCalls("[TOOL: exact_edit | a.py ||| old text ||| new text]");
  assert.deepEqual(edit, { tool: "exact_edit", args: { filePath: "a.py", oldString: "old text", newString: "new text" } });

  const [spawn] = parseTextToolCalls("[TOOL: spawn_subagent | explore ||| Auditor ||| find secrets]");
  assert.deepEqual(spawn.args, { type: "explore", role: "Auditor", prompt: "find secrets" });

  const [short] = parseTextToolCalls("[TOOL: spawn_subagent | just a prompt]");
  assert.deepEqual(short.args, { prompt: "just a prompt" });

  const [bad] = parseTextToolCalls("[TOOL: exact_edit | only-one-part]");
  assert.deepEqual(bad.args, {}, "malformed exact_edit must not invent arguments");
});

test("text fallback: unknown tools accept JSON arguments, else keep the raw text", () => {
  const [json] = parseTextToolCalls('[TOOL: mcp_call | {"name":"multiply","arguments":{"a":2}}]');
  assert.deepEqual(json.args, { name: "multiply", arguments: { a: 2 } });
  const [raw] = parseTextToolCalls("[TOOL: some_custom | free text]");
  assert.deepEqual(raw.args, { content: "free text" });
});

test("text fallback: multiple calls in one reply keep their order; prose and absence are handled", () => {
  const calls = parseTextToolCalls("First [TOOL: git_status] then [TOOL: list_subagents] done");
  assert.deepEqual(calls.map(c => c.tool), ["git_status", "list_subagents"]);
  assert.deepEqual(parseTextToolCalls("no tools here"), []);
  assert.deepEqual(parseTextToolCalls(""), []);
  assert.deepEqual(parseTextToolCalls(null), []);
});

test("deliverable blocks: ===FILE:=== sections are extracted and code fences stripped", () => {
  const files = parseDeliverableBlocksText(
    "intro\n===FILE: app.py===\n```python\nprint('hi')\n```\n===END_FILE===\n===FILE: notes.md===\n# Notes\n===END_FILE===\n"
  );
  assert.deepEqual(files, [
    { name: "app.py", content: "print('hi')" },
    { name: "notes.md", content: "# Notes" }
  ]);
});

test("deliverable blocks: a missing END marker ends at the next FILE block or end of text; empty files are skipped", () => {
  const files = parseDeliverableBlocksText("===FILE: a.txt===\nA body\n===FILE: b.txt===\nB body");
  assert.deepEqual(files.map(f => f.name), ["a.txt", "b.txt"]);
  assert.equal(files[1].content, "B body");
  assert.deepEqual(parseDeliverableBlocksText("===FILE: empty.txt===\n===END_FILE==="), []);
  assert.deepEqual(parseDeliverableBlocksText(""), []);
});

test("text fallback: brackets inside a command do not end the tag early (regression)", () => {
  const [a] = parseTextToolCalls('[TOOL: shell_exec | python3 -c "import sys; print(sys.argv[1])" x]');
  assert.equal(a.args.command, 'python3 -c "import sys; print(sys.argv[1])" x');
  const [b] = parseTextToolCalls("[TOOL: shell_exec | [ -f a.txt ] && echo yes]");
  assert.equal(b.args.command, "[ -f a.txt ] && echo yes");
  const calls = parseTextToolCalls("[TOOL: fs_read | a[0].py] then [TOOL: git_status] and [TOOL: shell_exec | echo broken");
  assert.deepEqual(calls.map(c => c.tool), ["fs_read", "git_status"], "an unterminated tag is ignored");
});

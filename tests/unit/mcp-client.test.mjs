import "./_env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callStdioMcpServer, splitCommandLine } from "../../ui/src/mcp-client.mjs";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const FIXTURE_CMD = "node mcp-test-server.mjs";

test("splitCommandLine: whitespace, quotes and escapes", () => {
  assert.deepEqual(splitCommandLine("npx -y server"), ["npx", "-y", "server"]);
  assert.deepEqual(splitCommandLine("  a   b  "), ["a", "b"]);
  assert.deepEqual(splitCommandLine('node "/Users/John Smith/srv.mjs" --root "/tmp/a b"'), ["node", "/Users/John Smith/srv.mjs", "--root", "/tmp/a b"]);
  assert.deepEqual(splitCommandLine("run 'single quoted $HOME' x"), ["run", "single quoted $HOME", "x"]);
  assert.deepEqual(splitCommandLine('say "he said \\"hi\\""'), ["say", 'he said "hi"']);
  assert.deepEqual(splitCommandLine('x "" y'), ["x", "", "y"], "an explicit empty argument is preserved");
  assert.deepEqual(splitCommandLine("a'b c'd"), ["ab cd"], "quotes inside a word join the pieces");
  assert.deepEqual(splitCommandLine("   "), []);
  assert.deepEqual(splitCommandLine(""), []);
  assert.deepEqual(splitCommandLine(null), []);
});

test("splitCommandLine: unterminated quote is lenient rather than throwing", () => {
  assert.deepEqual(splitCommandLine('node "unterminated arg'), ["node", "unterminated arg"]);
});

test("MCP client: initialize + tools/list over real stdio", async () => {
  const res = await callStdioMcpServer({ commandLine: FIXTURE_CMD, cwd: FIXTURES, method: "tools/list" });
  assert.equal(res.ok, true, JSON.stringify(res));
  const names = res.result.tools.map(t => t.name);
  assert.deepEqual(names, ["multiply", "argv"]);
  assert.deepEqual(res.result.tools[0].inputSchema.required, ["a", "b"]);
});

test("MCP client: tools/call returns the tool result", async () => {
  const res = await callStdioMcpServer({
    commandLine: FIXTURE_CMD, cwd: FIXTURES, method: "tools/call",
    params: { name: "multiply", arguments: { a: 7, b: 6 } }
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result.content[0].text, "PRODUCT=42");
});

test("MCP client: quoted arguments with spaces reach the server intact", async () => {
  const res = await callStdioMcpServer({
    commandLine: 'node mcp-test-server.mjs default --root "/tmp/a b" plain', cwd: FIXTURES, method: "tools/call",
    params: { name: "argv", arguments: {} }
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result.content[0].text, "--root|/tmp/a b|plain");
});

test("MCP client: a server that dies at startup yields ok:false with its stderr", async () => {
  const res = await callStdioMcpServer({ commandLine: "node mcp-test-server.mjs crash", cwd: FIXTURES, method: "tools/list" });
  assert.equal(res.ok, false);
  assert.match(res.error, /exited with code 3/);
  assert.match(res.stderr, /simulated startup failure/);
});

test("MCP client: a missing binary yields ok:false, not a hang or throw", async () => {
  const res = await callStdioMcpServer({ commandLine: "definitely-not-a-real-binary-xyz", cwd: FIXTURES });
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test("MCP client: an empty command is rejected up front", async () => {
  const res = await callStdioMcpServer({ commandLine: "   " });
  assert.deepEqual(res, { ok: false, error: "Empty MCP command" });
});

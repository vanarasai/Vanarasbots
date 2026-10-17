// Minimal stdio MCP server used to exercise the real client end to end (no mocks of the transport).
// Modes (argv[2]): default | crash (exits non-zero with a stderr message before answering).
import readline from "node:readline";

const mode = process.argv[2] || "default";
const extra = process.argv.slice(3);

if (mode === "crash") {
  process.stderr.write("fixture: simulated startup failure\n");
  process.exit(3);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
  if (req.method === "initialize") {
    reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "vanaras-fixture", version: "1.0.0" } });
  } else if (req.method === "tools/list") {
    reply({
      tools: [
        { name: "multiply", description: "Multiply two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
        { name: "argv", description: "Echo the extra argv this server was launched with", inputSchema: { type: "object", properties: {} } }
      ]
    });
  } else if (req.method === "tools/call") {
    const { name, arguments: args = {} } = req.params || {};
    if (name === "multiply") reply({ content: [{ type: "text", text: `PRODUCT=${Number(args.a) * Number(args.b)}` }] });
    else if (name === "argv") reply({ content: [{ type: "text", text: extra.join("|") }] });
    else reply({ isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] });
  }
});

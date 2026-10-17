// Native tool schema advertised to models, plus text-tag fallback parsing for local models.
// 6B-1. Native Tools Schema for Autonomous Squad Agents (P1b & P2)
export const VANARAS_NATIVE_TOOLS = [
  {
    type: "function",
    function: {
      name: "exact_edit",
      description: "Surgically edit a file by finding a unique target string and replacing it with new content. Fails if the target string appears 0 times or more than 1 time.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path to file to edit (relative to workspace or worktree)" },
          oldString: { type: "string", description: "The exact substring to replace. Must match existing file content character-for-character and appear exactly once." },
          newString: { type: "string", description: "The new replacement content to insert in place of oldString." }
        },
        required: ["filePath", "oldString", "newString"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fs_read",
      description: "Read the content of a file or inspect directory entries.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path to file or directory to read" }
        },
        required: ["filePath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fs_write",
      description: "Write full file content to the agent workspace and worktree.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path to file to write" },
          content: { type: "string", description: "Full content to write to the file" }
        },
        required: ["filePath", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "shell_exec",
      description: "Execute a shell command inside the agent's worktree with process-tree tracking.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command line to execute" },
          timeout: { type: "integer", description: "Timeout in milliseconds (default: 120000, max: 300000)" }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "grep_search",
      description: "Fast regex or literal code search across files with line number matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern or query" },
          isRegex: { type: "boolean", description: "Whether pattern is a regular expression" },
          path: { type: "string", description: "Optional subpath or directory to scope search" }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description: "Find files in the workspace matching a name or glob pattern.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "File name substring or glob pattern (e.g. *.py, server*)" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "start_process",
      description: "Start a long-running background process (such as a local dev server or test watcher) without blocking the turn.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to start in the background" },
          name: { type: "string", description: "Optional descriptive label for this process" }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "stop_process",
      description: "Stop a background process previously started with start_process.",
      parameters: {
        type: "object",
        properties: {
          processId: { type: "string", description: "Process ID returned from start_process" }
        },
        required: ["processId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_process_logs",
      description: "Get recent log lines from a background process.",
      parameters: {
        type: "object",
        properties: {
          processId: { type: "string", description: "Process ID returned from start_process" },
          lines: { type: "integer", description: "Number of recent lines to retrieve (default: 50)" }
        },
        required: ["processId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "verify_project",
      description: "Run the project's test suite or verification script (e.g. ./run.sh, pytest, npm test) and return exit code and failure traceback to self-heal.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Optional verification command (defaults to ./run.sh, pytest, or npm test)" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Check git status and modified files in the agent's worktree.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Check git unified diff for current modifications in the worktree.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Commit current changes in the agent worktree.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Commit message" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "spawn_subagent",
      description: "Spawn an autonomous subagent in an isolated git worktree. Types: 'explore' (read-only search & inspection), 'plan' (architecture & breakdown), 'general' (coding & testing in worktree).",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["explore", "plan", "general"], description: "Subagent specialization type" },
          role: { type: "string", description: "Role or job title (e.g. 'Explore Tests', 'Planner', 'Backend Dev')" },
          prompt: { type: "string", description: "Clear instructions and objective for the subagent" }
        },
        required: ["type", "role", "prompt"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_subagent_output",
      description: "Retrieve status, reasoning, and deliverables from a spawned subagent by subagentId.",
      parameters: {
        type: "object",
        properties: {
          subagentId: { type: "string", description: "ID of the subagent" }
        },
        required: ["subagentId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_subagents",
      description: "List all active and completed subagents with their status and outputs.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "mcp_probe",
      description: "Probe an external Model Context Protocol (MCP) server over stdio to list available tools and schemas.",
      parameters: {
        type: "object",
        properties: {
          mcpCommand: { type: "string", description: "Command line to launch the stdio MCP server (e.g. 'npx -y @modelcontextprotocol/server-filesystem /path' or 'python -m mcp_server')" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "mcp_call",
      description: "Execute a tool provided by an external Model Context Protocol (MCP) server over stdio.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the MCP tool to execute" },
          arguments: { type: "object", description: "Arguments dictionary for the MCP tool" },
          mcpCommand: { type: "string", description: "Optional MCP server command (uses agent's configured MCP server if omitted)" }
        },
        required: ["name"]
      }
    }
  }
];

export function parseTextToolCalls(text) {
  if (!text) return [];
  const calls = [];
  const toolRx = /\[TOOL:\s*([a-zA-Z0-9_.-]+)(?:\s*\|\s*([\s\S]*?))?\]/gi;
  let match;
  while ((match = toolRx.exec(text)) !== null) {
    const name = match[1].trim();
    const rawArg = (match[2] || "").trim();
    let args = {};
    if (name === "shell_exec" || name === "shell") {
      args = { command: rawArg };
    } else if (name === "fs_read") {
      args = { filePath: rawArg };
    } else if (name === "exact_edit") {
      const parts = rawArg.split("|||");
      if (parts.length >= 3) {
        args = { filePath: parts[0].trim(), oldString: parts[1].trim(), newString: parts[2].trim() };
      }
    } else if (name === "grep_search") {
      args = { pattern: rawArg };
    } else if (name === "find_files") {
      args = { query: rawArg };
    } else if (name === "verify_project") {
      args = { command: rawArg };
    } else if (name === "start_process") {
      args = { command: rawArg };
    } else if (name === "stop_process" || name === "get_process_logs") {
      args = { processId: rawArg };
    } else if (name === "get_subagent_output") {
      args = { subagentId: rawArg };
    } else if (name === "list_subagents") {
      args = {};
    } else if (name === "spawn_subagent") {
      const parts = rawArg.split("|||");
      if (parts.length >= 3) {
        args = { type: parts[0].trim(), role: parts[1].trim(), prompt: parts[2].trim() };
      } else {
        args = { prompt: rawArg };
      }
    } else if (name === "git_commit") {
      args = { message: rawArg };
    } else {
      try {
        args = JSON.parse(rawArg);
      } catch {
        args = { content: rawArg };
      }
    }
    calls.push({ tool: name, args });
  }
  return calls;
}

export function parseDeliverableBlocksText(rawText) {
  if (!rawText) return [];
  const files = [];
  const regex = /===FILE:\s*([^\n=]+)===\s*\n([\s\S]*?)(===END_FILE===|(?====FILE:)|$)/gi;
  let m;
  while ((m = regex.exec(rawText)) !== null) {
    const rawName = (m[1] || "").trim();
    let content = (m[2] || "").trim()
      .replace(/^```[a-zA-Z0-9_.-]*\r?\n/, "")
      .replace(/\r?\n```\s*$/, "")
      .trim();
    if (rawName && content) {
      files.push({ name: rawName, content });
    }
  }
  return files;
}

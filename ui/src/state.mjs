// Process-wide mutable registries (SSE clients, running jobs, turns, subagents, approvals, checkpoints).
// Connected real-time multiplayer clients (SSE)
export const sseClients = new Set();

// Background tasks, per-agent dev servers, active script runs, file watchers & heartbeat timers
export const backgroundJobs = new Map();

export const activeRunProcs = new Map();

export const agentDevServers = new Map();

export const agentWatchers = new Map();

export const agentHeartbeats = new Map();

// P1a & P2: Process supervision for agent background tasks and server-side session turns
export const agentBackgroundProcesses = new Map();

export const activeServerTurns = new Map();

// P4: Dynamic Subagents (General, Explore, Plan) with Worktree Isolation
export const activeSubagents = new Map();

// P3: Approvals (Allow/Ask/Deny) and Session Checkpoints / Rewind
export const activeApprovals = new Map();

export const sessionCheckpoints = new Map();

export const managedAgentPortProcesses = new Map();

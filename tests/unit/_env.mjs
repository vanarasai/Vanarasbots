// Imported FIRST by every unit test. ES module imports evaluate in order, so this runs before any ui/src
// module reads its configuration. All mutable state is redirected to a throwaway directory, which keeps
// the unit suite from touching a developer's real state, keys vault, or worktrees.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "vanaras-unit-"));
process.env.VANARAS_STATE_DIR = path.join(SANDBOX, "state");
process.env.VANARAS_WORKTREES_DIR = path.join(SANDBOX, "worktrees");

process.on("exit", () => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ }
});

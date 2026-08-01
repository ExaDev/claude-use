import os from "node:os";
import path from "node:path";

// Permanent structural safety net, not a one-off assertion: Joe's real, currently-in-daily-use identities live at ~/.claude-use/active and ~/.claude-use/profiles/{mearman,exadev}/. Nothing in this project's test suite may read, write, or touch those paths, directly or indirectly. Every test run must set CLAUDE_USE_HOME to a throwaway directory (vitest.config.ts does this globally), and this file refuses to let a test suite run at all if that has not happened.
const claudeUseHome = process.env.CLAUDE_USE_HOME;
const realClaudeUseHome = path.join(os.homedir(), ".claude-use");

if (claudeUseHome === undefined || claudeUseHome === "") {
  throw new Error(
    "CLAUDE_USE_HOME is not set. Every test in this project must set CLAUDE_USE_HOME to a " +
      "throwaway directory before running, to guarantee no test can ever touch Joe's real, " +
      "currently-in-daily-use identities under the real ~/.claude-use.",
  );
}

if (path.resolve(claudeUseHome) === realClaudeUseHome) {
  throw new Error(
    `CLAUDE_USE_HOME resolves to the real ${realClaudeUseHome}. Tests must never point at the ` +
      "real claude-use root — use a throwaway os.tmpdir() subdirectory instead.",
  );
}

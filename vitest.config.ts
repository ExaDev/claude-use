import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Every test run gets its own throwaway CLAUDE_USE_HOME, well away from Joe's real, currently-in-daily-use identities at ~/.claude-use/active and ~/.claude-use/profiles/{mearman,exadev}/. src/test-setup.ts asserts this env var is set and does not resolve to the real ~/.claude-use before any test body runs, so no test in this project can ever touch real state.
const testClaudeUseHome = path.join(os.tmpdir(), `claude-use-test-${process.pid}-${Date.now()}`);

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/test-setup.ts"],
    env: {
      CLAUDE_USE_HOME: testClaudeUseHome,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-setup.ts"],
    },
  },
});

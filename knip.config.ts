import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // src/resolve.ts is the documented public facade re-exporting src/resolve/* -- nothing outside src/resolve/ imports its internals directly, so its re-exports are a boundary, not dead code.
  entry: ["src/cli.ts", "src/resolve.ts"],
  project: ["src/**/*.ts"],
  ignoreDependencies: [
    // Referenced by preset/plugin name in release.config.ts, not by import -- knip can't trace this.
    "@semantic-release/npm",
    "conventional-changelog-conventionalcommits",
  ],
};

export default config;

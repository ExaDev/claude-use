import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["src/cli.ts"],
  project: ["src/**/*.ts", "eslint-rules/**/*.ts"],
  ignoreDependencies: [
    // Referenced by preset/plugin name in release.config.ts, not by import -- knip can't trace this.
    "@semantic-release/npm",
    "conventional-changelog-conventionalcommits",
  ],
};

export default config;

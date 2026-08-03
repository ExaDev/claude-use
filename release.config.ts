import type { Options } from "semantic-release";

/**
 * Runs on `main`. Decides the next version from Conventional Commits (feat -> minor, fix/perf -> patch, a BREAKING CHANGE footer -> major), then creates and pushes the tag plus a chore(release) commit bumping CHANGELOG.md and package.json. @semantic-release/npm runs with npmPublish: false so it only bumps the version field -- actual npm publishing (OIDC trusted publishing), GitHub Release creation, and the Homebrew/Scoop tap updates are this project's own jobs in .github/workflows/ci.yml, not semantic-release plugins, since they need this project's own multi-platform asset list and release notes body rather than @semantic-release/github's generic ones.
 */
const config: Options = {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    ["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
    ["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
    "@semantic-release/changelog",
    ["@semantic-release/npm", { npmPublish: false }],
    [
      "@semantic-release/git",
      {
        assets: ["CHANGELOG.md", "package.json"],
        message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
  ],
};

export default config;

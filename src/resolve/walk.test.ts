import { describe, expect, it } from "vitest";

import type { ConfigProfile } from "../config/schema";
import { FAKE_HOME } from "../test-helpers";
import type { ProfileLoader } from "./extends";
import { assembleCascade, walkDirectoryAncestors, type DirectoryLevelSources } from "./walk";

const home = FAKE_HOME;

function loader(profiles: Readonly<Record<string, ConfigProfile>>): ProfileLoader {
  return (name) => {
    const profile = profiles[name];
    return profile === undefined ? undefined : { name, profile };
  };
}

describe("walkDirectoryAncestors", () => {
  it("returns the working directory and every ancestor, shallowest-first", () => {
    expect(walkDirectoryAncestors(`${home}/work/clients/acme`, { home })).toEqual([
      home,
      `${home}/work`,
      `${home}/work/clients`,
      `${home}/work/clients/acme`,
    ]);
  });

  it("stops at, and includes, the limit directory", () => {
    expect(walkDirectoryAncestors(`${home}/work/clients`, { home, limit: `${home}/work` })).toEqual([
      `${home}/work`,
      `${home}/work/clients`,
    ]);
  });

  it("returns just the working directory when it is the limit", () => {
    expect(walkDirectoryAncestors(home, { home })).toEqual([home]);
  });

  it("stops at the filesystem root when the working directory is not beneath the limit at all", () => {
    const walked = walkDirectoryAncestors("/var/tmp/scratch", { home });
    expect(walked[0]).toBe("/");
    expect(walked.at(-1)).toBe("/var/tmp/scratch");
  });

  it("stops at an unreadable ancestor rather than failing the launch", () => {
    const walked = walkDirectoryAncestors(`${home}/work/clients/acme`, {
      home,
      isReadable: (dir) => dir !== `${home}/work`,
    });
    expect(walked).toEqual([`${home}/work/clients`, `${home}/work/clients/acme`]);
  });

  it("returns nothing when the working directory itself is unreadable", () => {
    expect(walkDirectoryAncestors(`${home}/secret`, { home, isReadable: () => false })).toEqual([]);
  });
});

describe("assembleCascade layer ordering", () => {
  const load = loader({ base: {}, work: { extends: ["base"] }, strict: {} });

  it("puts the global config first, the base profile chain next, then directory levels, then CLI overrides", () => {
    const levels: DirectoryLevelSources[] = [
      { dir: `${home}/work`, portable: { config: { categories: { history: true } }, filepath: `${home}/work/.claude-use.json` } },
    ];
    const assembled = assembleCascade({
      home,
      globalConfig: { config: { categories: { knowledge: true } }, filepath: "/cfg/config.json" },
      baseConfigProfile: "work",
      loadProfile: load,
      levels,
      cliOverride: { categories: { history: false } },
    });
    expect(assembled.layers.map((layer) => layer.kind)).toEqual([
      "global-config",
      "config-profile",
      "config-profile",
      "portable",
      "cli-override",
    ]);
    expect(assembled.layers.map((layer) => layer.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it("folds a level's three sources most-personal-last: committed file, then this user's rules, then the local override", () => {
    const levels: DirectoryLevelSources[] = [
      {
        dir: `${home}/work`,
        portable: { config: {}, filepath: "committed" },
        rules: [{ rule: { path: `${home}/work` }, filepath: "rules" }],
        portableLocal: { config: {}, filepath: "local" },
      },
    ];
    const assembled = assembleCascade({ home, loadProfile: load, levels });
    expect(assembled.layers.map((layer) => layer.source)).toEqual(["committed", "rules", "local"]);
  });

  it("keeps the whole shallowest-to-deepest walk as one continuous sequence, not gathered per source across the tree", () => {
    const levels: DirectoryLevelSources[] = [
      { dir: `${home}/work`, portable: { config: {}, filepath: "shallow-committed" }, portableLocal: { config: {}, filepath: "shallow-local" } },
      { dir: `${home}/work/acme`, portable: { config: {}, filepath: "deep-committed" } },
    ];
    const assembled = assembleCascade({ home, loadProfile: load, levels });
    expect(assembled.layers.map((layer) => layer.source)).toEqual(["shallow-committed", "shallow-local", "deep-committed"]);
  });

  it("preserves the file order of several rules matching the same directory", () => {
    const levels: DirectoryLevelSources[] = [
      {
        dir: `${home}/work`,
        rules: [
          { rule: { path: `${home}/work` }, filepath: "rule-1" },
          { rule: { path: `${home}/work` }, filepath: "rule-2" },
        ],
      },
    ];
    expect(assembleCascade({ home, loadProfile: load, levels }).layers.map((layer) => layer.source)).toEqual([
      "rule-1",
      "rule-2",
    ]);
  });
});

describe("assembleCascade profile composition", () => {
  const load = loader({
    "work-default": { categories: { history: true } },
    "client-strict": { extends: ["work-default"], categories: { history: false } },
  });

  it("composes a level's selected profile in before that level's own inline overrides, rather than swapping it in wholesale", () => {
    const levels: DirectoryLevelSources[] = [
      {
        dir: `${home}/work`,
        rules: [
          {
            rule: { path: `${home}/work`, configProfile: "client-strict", entries: { "knowledge/skills/commit": true } },
            filepath: "rules",
          },
        ],
      },
    ];
    const assembled = assembleCascade({ home, loadProfile: load, levels });
    expect(assembled.layers.map((layer) => layer.source)).toEqual(["work-default", "client-strict", "rules"]);
    expect(assembled.layers.at(-1)?.entries).toEqual({ "knowledge/skills/commit": true });
  });

  it("reports a missing profile named by a directory rule", () => {
    const levels: DirectoryLevelSources[] = [
      { dir: `${home}/work`, rules: [{ rule: { path: `${home}/work`, configProfile: "gone" }, filepath: "rules" }] },
    ];
    const assembled = assembleCascade({ home, loadProfile: load, levels });
    expect(assembled.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["MISSING_PROFILE"]);
  });
});

describe("assembleCascade pins", () => {
  const load = loader({});

  it("reports the deepest identity pin, which the launcher uses as a safety net beneath an explicit @name", () => {
    const levels: DirectoryLevelSources[] = [
      { dir: `${home}/work`, rules: [{ rule: { path: `${home}/work`, identity: "work" }, filepath: "a" }] },
      { dir: `${home}/work/acme`, rules: [{ rule: { path: `${home}/work/acme`, identity: "acme" }, filepath: "b" }] },
    ];
    expect(assembleCascade({ home, loadProfile: load, levels }).identityPin).toBe("acme");
  });

  it("reports no identity pin when no level sets one", () => {
    expect(assembleCascade({ home, loadProfile: load, levels: [{ dir: home }] }).identityPin).toBeUndefined();
  });

  it("reports the deepest directory-level profile selection", () => {
    const levels: DirectoryLevelSources[] = [
      { dir: `${home}/work`, portable: { config: { configProfile: "a" }, filepath: "a" } },
      { dir: `${home}/work/acme`, portable: { config: { configProfile: "b" }, filepath: "b" } },
    ];
    expect(assembleCascade({ home, loadProfile: loader({ a: {}, b: {} }), levels }).directoryConfigProfile).toBe("b");
  });
});

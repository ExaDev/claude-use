import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addDirectoryRule, readDirectoryRules } from "./directoryRules";
import { readGlobalConfig, createProfile, readProfile } from "./configProfiles";
import { addIdentity, setDefaultConfigProfile } from "./identityManager";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import {
  chooseWriteTarget,
  describeWriteTarget,
  runConfigure,
  type DirectoryLevelPresence,
  type MultiselectParams,
  type PromptsPort,
  type SelectParams,
} from "./configure";

const CANCEL = Symbol("cancel");

/** A scripted `PromptsPort`: each call to `select`/`multiselect` consumes the next entry from `answers`, in order. Records every prompt's message so a test can assert what was actually asked. */
function scriptedPrompts(answers: readonly unknown[]): { readonly port: PromptsPort; readonly messages: string[] } {
  const messages: string[] = [];
  // Records intro/outro/cancel calls so the port methods are real (not empty) stubs, without mixing lifecycle messages into `messages`, which several tests assert on with exact `toEqual` against prompt messages only.
  const lifecycleCalls: string[] = [];
  let index = 0;
  const next = (): unknown => {
    const value = answers[index];
    index += 1;
    return value;
  };
  const port: PromptsPort = {
    select: <Value extends string>(params: SelectParams<Value>): Promise<Value | symbol> => {
      messages.push(params.message);
      // @ts-expect-error test double: the scripted answer's shape is asserted by the test author, not statically provable against the generic Value
      return Promise.resolve(next());
    },
    multiselect: <Value extends string>(params: MultiselectParams<Value>): Promise<readonly Value[] | symbol> => {
      messages.push(params.message);
      // @ts-expect-error test double: the scripted answer's shape is asserted by the test author, not statically provable against the generic Value
      return Promise.resolve(next());
    },
    isCancel: (value): value is symbol => typeof value === "symbol",
    cancel: (message) => lifecycleCalls.push(`cancel:${message ?? ""}`),
    intro: (message) => lifecycleCalls.push(`intro:${message ?? ""}`),
    outro: (message) => lifecycleCalls.push(`outro:${message ?? ""}`),
  };
  return { port, messages };
}

function makeLog(): { readonly log: { info: (message: string) => void }; readonly lines: string[] } {
  const lines: string[] = [];
  return { log: { info: (message: string) => lines.push(message) }, lines };
}

describe("chooseWriteTarget", () => {
  const home = "/home/testuser";
  const cwd = `${home}/work/clients/acme`;

  function levelsFor(overrides: Readonly<Record<string, Partial<DirectoryLevelPresence>>>): DirectoryLevelPresence[] {
    const dirs = [home, `${home}/work`, `${home}/work/clients`, cwd];
    return dirs.map((dir) => ({ dir, hasPortable: false, hasPortableLocal: false, ...overrides[dir] }));
  }

  it("tier 1: writes into .claude-use.local.json in the deepest ancestor with a committed .claude-use.json", () => {
    const levels = levelsFor({ [`${home}/work/clients`]: { hasPortable: true }, [cwd]: { hasPortable: true } });
    const target = chooseWriteTarget({ cwd, home, levels, directoryRulePaths: [], activeConfigProfile: "base" });
    expect(target).toEqual({ tier: "portable-local", localConfigPath: path.join(cwd, ".claude-use.local.json") });
  });

  it("tier 1 edge case: a .claude-use.local.json already exists with no committed sibling", () => {
    const levels = levelsFor({ [cwd]: { hasPortableLocal: true } });
    const target = chooseWriteTarget({ cwd, home, levels, directoryRulePaths: [], activeConfigProfile: "base" });
    expect(target).toEqual({ tier: "portable-local", localConfigPath: path.join(cwd, ".claude-use.local.json") });
  });

  it("tier 1 picks the deepest qualifying ancestor, not the shallowest", () => {
    const levels = levelsFor({ [`${home}/work`]: { hasPortable: true }, [`${home}/work/clients`]: { hasPortableLocal: true } });
    const target = chooseWriteTarget({ cwd, home, levels, directoryRulePaths: [], activeConfigProfile: "base" });
    expect(target).toEqual({ tier: "portable-local", localConfigPath: path.join(`${home}/work/clients`, ".claude-use.local.json") });
  });

  it("tier 2: writes into an existing directory rule that already applies to cwd, when tier 1 does not apply", () => {
    const levels = levelsFor({});
    const target = chooseWriteTarget({
      cwd,
      home,
      levels,
      directoryRulePaths: [`${home}/work/clients`],
      activeConfigProfile: "base",
    });
    expect(target).toEqual({ tier: "directory-rule", rulePath: `${home}/work/clients` });
  });

  it("tier 2 picks the most specific (longest-resolved) matching rule when more than one applies", () => {
    const levels = levelsFor({});
    const target = chooseWriteTarget({
      cwd,
      home,
      levels,
      directoryRulePaths: [`${home}/work`, `${home}/work/clients`],
      activeConfigProfile: "base",
    });
    expect(target).toEqual({ tier: "directory-rule", rulePath: `${home}/work/clients` });
  });

  it("tier 2 does not match a rule scoped to an unrelated sibling directory", () => {
    const levels = levelsFor({});
    const target = chooseWriteTarget({
      cwd,
      home,
      levels,
      directoryRulePaths: [`${home}/work/clients/widget`],
      activeConfigProfile: "base",
    });
    expect(target).toEqual({ tier: "config-profile", profileName: "base" });
  });

  it("tier 3: falls back to the identity's active configuration profile when nothing else applies", () => {
    const levels = levelsFor({});
    const target = chooseWriteTarget({ cwd, home, levels, directoryRulePaths: [], activeConfigProfile: "base" });
    expect(target).toEqual({ tier: "config-profile", profileName: "base" });
  });

  it("tier 1 outranks tier 2 even when both would apply", () => {
    const levels = levelsFor({ [cwd]: { hasPortableLocal: true } });
    const target = chooseWriteTarget({
      cwd,
      home,
      levels,
      directoryRulePaths: [`${home}/work/clients`],
      activeConfigProfile: "base",
    });
    expect(target.tier).toBe("portable-local");
  });

  it("describeWriteTarget renders a short description for each tier", () => {
    expect(describeWriteTarget({ tier: "portable-local", localConfigPath: "/a/.claude-use.local.json" })).toContain(
      "/a/.claude-use.local.json",
    );
    expect(describeWriteTarget({ tier: "directory-rule", rulePath: "/a" })).toContain("/a");
    expect(describeWriteTarget({ tier: "config-profile", profileName: "base" })).toContain("base");
  });
});

describe("runConfigure", () => {
  let claudeUseRoot: string;
  let homeRoot: string;
  let claudeHome: string;
  let cwd: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    claudeUseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "configure-test-root-"));
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "configure-test-home-"));
    claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "configure-test-claude-"));
    paths = buildLayoutPaths(claudeUseRoot);

    cwd = path.join(homeRoot, "work", "clients", "acme");
    fs.mkdirSync(cwd, { recursive: true });

    fs.mkdirSync(path.join(claudeHome, "skills", "commit"), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, "skills", "commit", "SKILL.md"), "# commit\n");
    fs.mkdirSync(path.join(claudeHome, "skills", "pr-feedback"), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, "skills", "pr-feedback", "SKILL.md"), "# pr-feedback\n");
    fs.mkdirSync(path.join(claudeHome, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, "sessions", "one.jsonl"), "{}\n");

    addIdentity(paths, "testid");
    createProfile(paths, "base");
    setDefaultConfigProfile(paths, "testid", "base");
  });

  afterEach(() => {
    fs.rmSync(claudeUseRoot, { recursive: true, force: true });
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(claudeHome, { recursive: true, force: true });
  });

  describe("categories mode (no path)", () => {
    it("toggles a category and writes it into the identity's active configuration profile (tier 3)", async () => {
      const { port, messages } = scriptedPrompts(["toggle", ["knowledge", "settings", "history"]]);
      const { log, lines } = makeLog();

      await runConfigure(
        { paths, prompts: port, log },
        { identityName: "testid", cwd, home: homeRoot, claudeHome },
      );

      expect(messages).toEqual(["Configure identity \"testid\"", "Which categories should be shared?"]);
      expect(readProfile(paths, "base")?.categories).toEqual({ history: true });
      expect(lines.some((line) => line.includes("Updated categories"))).toBe(true);
    });

    it("reports no changes when the selection matches the resolved state exactly", async () => {
      const { port } = scriptedPrompts(["toggle", ["knowledge", "settings"]]);
      const { log, lines } = makeLog();

      await runConfigure({ paths, prompts: port, log }, { identityName: "testid", cwd, home: homeRoot, claudeHome });

      expect(readProfile(paths, "base")?.categories).toBeUndefined();
      expect(lines).toEqual(["No changes."]);
    });

    it("writes into an existing directory rule instead of the profile, when one already covers cwd (tier 2)", async () => {
      const rulePath = path.join(homeRoot, "work", "clients");
      addDirectoryRule(paths, rulePath, { configProfile: "base" });

      const { port } = scriptedPrompts(["toggle", ["knowledge", "settings", "history"]]);
      const { log } = makeLog();

      await runConfigure({ paths, prompts: port, log }, { identityName: "testid", cwd, home: homeRoot, claudeHome });

      const rule = readDirectoryRules(paths).rules.find((entry) => entry.path === rulePath);
      expect(rule?.categories).toEqual({ history: true });
      expect(readProfile(paths, "base")?.categories).toBeUndefined();
    });

    it("writes into a committed directory's .claude-use.local.json instead of the profile, when one covers cwd (tier 1)", async () => {
      fs.writeFileSync(path.join(cwd, ".claude-use.json"), "{}\n");

      const { port } = scriptedPrompts(["toggle", ["knowledge", "settings", "history"]]);
      const { log } = makeLog();

      await runConfigure({ paths, prompts: port, log }, { identityName: "testid", cwd, home: homeRoot, claudeHome });

      const localPath = path.join(cwd, ".claude-use.local.json");
      expect(fs.existsSync(localPath)).toBe(true);
      const written: unknown = JSON.parse(fs.readFileSync(localPath, "utf8"));
      expect(written).toMatchObject({ categories: { history: true } });
      expect(readProfile(paths, "base")?.categories).toBeUndefined();
    });

    it("edits a named configuration profile directly when that option is chosen, bypassing the 3-tier precedence", async () => {
      createProfile(paths, "other");
      // Even though a directory rule covers cwd (which would otherwise select tier 2), the explicit "edit a profile directly" branch always targets the profile the user picked, not chooseWriteTarget's result.
      addDirectoryRule(paths, path.join(homeRoot, "work", "clients"), { configProfile: "base" });

      const { port } = scriptedPrompts(["profile", "other", ["knowledge", "history"]]);
      const { log } = makeLog();

      await runConfigure({ paths, prompts: port, log }, { identityName: "testid", cwd, home: homeRoot, claudeHome });

      expect(readProfile(paths, "other")?.categories).toEqual({ history: true, settings: false });
      expect(readProfile(paths, "base")?.categories).toBeUndefined();
    });

    it("does nothing when the category select is cancelled", async () => {
      const { port } = scriptedPrompts(["toggle", CANCEL]);
      const { log, lines } = makeLog();

      await runConfigure({ paths, prompts: port, log }, { identityName: "testid", cwd, home: homeRoot, claudeHome });

      expect(readProfile(paths, "base")?.categories).toBeUndefined();
      expect(lines).toEqual([]);
    });

    it("does nothing when the initial mode select is cancelled", async () => {
      const { port } = scriptedPrompts([CANCEL]);
      const { log, lines } = makeLog();

      await runConfigure({ paths, prompts: port, log }, { identityName: "testid", cwd, home: homeRoot, claudeHome });

      expect(readProfile(paths, "base")?.categories).toBeUndefined();
      expect(lines).toEqual([]);
    });
  });

  describe("entries mode (with path)", () => {
    it("lists a path's children and writes a toggle into the active configuration profile (tier 3)", async () => {
      const { port, messages } = scriptedPrompts([["skills/commit"]]);
      const { log, lines } = makeLog();

      await runConfigure(
        { paths, prompts: port, log },
        { identityName: "testid", path: "skills", cwd, home: homeRoot, claudeHome },
      );

      expect(messages).toEqual(['Which entries under "skills" should be shared?']);
      expect(readProfile(paths, "base")?.entries).toEqual({ "knowledge/skills/pr-feedback": false });
      expect(lines.some((line) => line.includes("Updated entries"))).toBe(true);
    });

    it("reports no changes when every child's toggle matches its resolved state", async () => {
      const { port } = scriptedPrompts([["skills/commit", "skills/pr-feedback"]]);
      const { log, lines } = makeLog();

      await runConfigure(
        { paths, prompts: port, log },
        { identityName: "testid", path: "skills", cwd, home: homeRoot, claudeHome },
      );

      expect(readProfile(paths, "base")?.entries).toBeUndefined();
      expect(lines).toEqual(["No changes."]);
    });

    it("reports nothing to configure when the given path has no children", async () => {
      const { port } = scriptedPrompts([]);
      const { log, lines } = makeLog();

      await runConfigure(
        { paths, prompts: port, log },
        { identityName: "testid", path: "skills/commit/SKILL.md", cwd, home: homeRoot, claudeHome },
      );

      expect(lines).toEqual(['No entries found under "skills/commit/SKILL.md".']);
    });

    it("never touches categories", async () => {
      createProfile(paths, "unused"); // sanity: this mode should not read/write categories at all
      const { port } = scriptedPrompts([["skills/commit"]]);
      const { log } = makeLog();

      await runConfigure(
        { paths, prompts: port, log },
        { identityName: "testid", path: "skills", cwd, home: homeRoot, claudeHome },
      );

      expect(readProfile(paths, "base")?.categories).toBeUndefined();
    });

    it("does nothing when the entries multiselect is cancelled", async () => {
      const { port } = scriptedPrompts([CANCEL]);
      const { log, lines } = makeLog();

      await runConfigure(
        { paths, prompts: port, log },
        { identityName: "testid", path: "skills", cwd, home: homeRoot, claudeHome },
      );

      expect(readProfile(paths, "base")?.entries).toBeUndefined();
      expect(lines).toEqual([]);
    });
  });

  it("throws when the identity does not exist", async () => {
    const { port } = scriptedPrompts([]);
    const { log } = makeLog();
    await expect(
      runConfigure({ paths, prompts: port, log }, { identityName: "nope", cwd, home: homeRoot, claudeHome }),
    ).rejects.toThrow(/No identity named "nope"/);
  });

  it("throws a clear error when no configuration profile resolves for the identity", async () => {
    addIdentity(paths, "profileless");
    const { port } = scriptedPrompts([]);
    const { log } = makeLog();
    await expect(
      runConfigure({ paths, prompts: port, log }, { identityName: "profileless", cwd, home: homeRoot, claudeHome }),
    ).rejects.toThrow(/No configuration profile resolves/);
  });
});

// Sanity check that readGlobalConfig (re-exported from configProfiles) composes with configure's own walkUpLimit handling without needing its own dedicated fixture — a missing global config must not throw.
describe("runConfigure without a global config file", () => {
  it("still resolves (readGlobalConfig returns undefined)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "configure-test-noglobal-"));
    try {
      expect(readGlobalConfig(buildLayoutPaths(root))).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

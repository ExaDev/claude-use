import { describe, expect, it } from "vitest";

import { createFakeFarmFs, FAKE_HOME } from "../test-helpers";
import { resolveFarmConflicts, type FarmConflict, type FarmConflictChoice } from "./farmResolve";

const IDENTITIES_DIR = `${FAKE_HOME}/.claude-use/identities`;
const FARM = `${IDENTITIES_DIR}/work`;
const PREVIOUS = `${IDENTITIES_DIR}/.work.previous.crashed`;

/** Always answers with the same fixed choice, regardless of which conflict is asked about. */
function fixedAnswer(choice: FarmConflictChoice): (conflict: FarmConflict) => Promise<FarmConflictChoice> {
  return () => Promise.resolve(choice);
}

describe("resolveFarmConflicts", () => {
  it("reports nothing to resolve when there is no superseded farm at all", async () => {
    const fs = createFakeFarmFs({ [`${FARM}/settings.json`]: "{}" });

    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: fixedAnswer("skip"),
    });

    expect(result).toEqual({ resolved: [], removed: [], retained: [] });
  });

  it("carries over non-colliding data and removes the superseded farm without asking anything", async () => {
    const fs = createFakeFarmFs({
      [`${FARM}/settings.json`]: "new",
      [`${PREVIOUS}/todos.json`]: "old todos",
    });

    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: fixedAnswer("skip"),
    });

    expect(result.resolved).toEqual([]);
    expect(result.removed).toEqual([PREVIOUS]);
    expect(result.retained).toEqual([]);
    expect(fs.readFileUtf8(`${FARM}/todos.json`)).toBe("old todos");
    expect(fs.lstat(PREVIOUS)).toBeUndefined();
  });

  it("keeps the current farm's copy and discards the superseded one on keep-new", async () => {
    const fs = createFakeFarmFs({
      [`${FARM}/settings.json`]: "new",
      [`${PREVIOUS}/settings.json`]: "old",
    });

    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: fixedAnswer("keep-new"),
    });

    expect(result.resolved).toEqual([{ previousRoot: PREVIOUS, farmRoot: FARM, name: "settings.json", choice: "keep-new" }]);
    expect(result.removed).toEqual([PREVIOUS]);
    expect(result.retained).toEqual([]);
    expect(fs.readFileUtf8(`${FARM}/settings.json`)).toBe("new");
    expect(fs.lstat(PREVIOUS)).toBeUndefined();
  });

  it("keeps the superseded farm's copy and replaces the current one on keep-old", async () => {
    const fs = createFakeFarmFs({
      [`${FARM}/settings.json`]: "new",
      [`${PREVIOUS}/settings.json`]: "old",
    });

    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: fixedAnswer("keep-old"),
    });

    expect(result.resolved).toEqual([{ previousRoot: PREVIOUS, farmRoot: FARM, name: "settings.json", choice: "keep-old" }]);
    expect(result.removed).toEqual([PREVIOUS]);
    expect(fs.readFileUtf8(`${FARM}/settings.json`)).toBe("old");
    expect(fs.lstat(PREVIOUS)).toBeUndefined();
  });

  it("leaves both copies and retains the superseded farm on skip", async () => {
    const fs = createFakeFarmFs({
      [`${FARM}/settings.json`]: "new",
      [`${PREVIOUS}/settings.json`]: "old",
    });

    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: fixedAnswer("skip"),
    });

    expect(result.resolved).toEqual([{ previousRoot: PREVIOUS, farmRoot: FARM, name: "settings.json", choice: "skip" }]);
    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual([PREVIOUS]);
    expect(fs.readFileUtf8(`${FARM}/settings.json`)).toBe("new");
    expect(fs.readFileUtf8(`${PREVIOUS}/settings.json`)).toBe("old");
  });

  it("resolves every retained previous farm across multiple prior launches, in sorted order", async () => {
    const previousA = `${IDENTITIES_DIR}/.work.previous.111.a`;
    const previousB = `${IDENTITIES_DIR}/.work.previous.222.b`;
    const fs = createFakeFarmFs({
      [`${FARM}/settings.json`]: "new",
      [`${previousA}/settings.json`]: "old-a",
      [`${previousB}/settings.json`]: "old-b",
    });

    const seen: string[] = [];
    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: (conflict) => {
        seen.push(conflict.previousRoot);
        return Promise.resolve("keep-new");
      },
    });

    expect(seen).toEqual([previousA, previousB]);
    expect(result.removed).toEqual([previousA, previousB]);
    expect(result.retained).toEqual([]);
  });

  it("only retains the previous farms with a skipped conflict, removing the rest", async () => {
    const previousA = `${IDENTITIES_DIR}/.work.previous.111.a`;
    const previousB = `${IDENTITIES_DIR}/.work.previous.222.b`;
    const fs = createFakeFarmFs({
      [`${FARM}/settings.json`]: "new",
      [`${previousA}/settings.json`]: "old-a",
      [`${previousB}/settings.json`]: "old-b",
    });

    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: (conflict) => Promise.resolve(conflict.previousRoot === previousA ? "skip" : "keep-new"),
    });

    expect(result.removed).toEqual([previousB]);
    expect(result.retained).toEqual([previousA]);
  });

  it("never asks about a directory the manifest recorded as materialised by the prior resync", async () => {
    const fs = createFakeFarmFs({
      [`${FARM}/projects`]: { dir: true },
      [`${PREVIOUS}/projects`]: { dir: true },
      [`${PREVIOUS}/.claude-use-farm.json`]: JSON.stringify({
        version: 1,
        builtAtMs: 1_000,
        identity: "work",
        cwd: `${FAKE_HOME}/work`,
        claudeHome: `${FAKE_HOME}/.claude`,
        materialised: ["projects"],
        links: [],
      }),
    });

    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: fixedAnswer("skip"),
    });

    expect(result.resolved).toEqual([]);
    expect(result.removed).toEqual([PREVIOUS]);
  });
});

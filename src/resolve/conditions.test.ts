import { describe, expect, it } from "vitest";

import { DAY_MS, FAKE_NOW_MS, makeFacts } from "../test-helpers";
import { evaluateWhen, isDuration, matchBranch, parseDuration, type ConditionContext } from "./conditions";
import type { EntryFact } from "./types";

const baseContext: ConditionContext = { nowMs: FAKE_NOW_MS, env: {} };

const HALF_SECOND_MS = 500;
const FORTY_FIVE_SECONDS_MS = 45_000;
const THIRTY_MINUTES_MS = 1_800_000;
const TWELVE_HOURS_MS = 43_200_000;
const DAYS_PER_WEEK = 7;
const NINETY = 90;

function fact(overrides: Partial<EntryFact>): EntryFact {
  return {
    relPath: "projects/-a-b",
    isDirectory: false,
    isSymlink: false,
    mtimeMs: FAKE_NOW_MS,
    latestMtimeMs: FAKE_NOW_MS,
    sizeBytes: 1,
    totalSizeBytes: 1,
    ...overrides,
  };
}

describe("parseDuration", () => {
  it.each([
    ["500ms", HALF_SECOND_MS],
    ["45s", FORTY_FIVE_SECONDS_MS],
    ["30m", THIRTY_MINUTES_MS],
    ["12h", TWELVE_HOURS_MS],
    ["90d", NINETY * DAY_MS],
    ["2w", 2 * DAYS_PER_WEEK * DAY_MS],
    ["0d", 0],
  ])("parses %s as %d ms", (value, expected) => {
    expect(parseDuration(value)).toBe(expected);
  });

  it.each(["90", "d", "1.5d", "-1d", "90 d", "90days", ""])("throws on the malformed duration %s", (value) => {
    expect(() => parseDuration(value)).toThrow();
    expect(isDuration(value)).toBe(false);
  });
});

describe("matchBranch", () => {
  it("matches a glob pattern against the checked-out branch", () => {
    expect(matchBranch("client/*", "client/acme")).toBe(true);
    expect(matchBranch("client/*", "main")).toBe(false);
    expect(matchBranch("main", "main")).toBe(true);
  });

  it("never matches when the directory is not a repository", () => {
    expect(matchBranch("*", undefined)).toBe(false);
    expect(matchBranch("*", "")).toBe(false);
  });

  it("never matches on a detached HEAD, where there is no branch to compare", () => {
    expect(matchBranch("*", "main", true)).toBe(false);
  });
});

describe("evaluateWhen", () => {
  it("passes when there is no condition at all", () => {
    expect(evaluateWhen(undefined, baseContext).passed).toBe(true);
  });

  it("passes vacuously on an empty condition object", () => {
    const result = evaluateWhen({}, baseContext);
    expect(result.passed).toBe(true);
    expect(result.checked).toEqual([]);
  });

  it("ANDs every present field within one object", () => {
    const context = { ...baseContext, branch: "client/acme", fact: fact({}) };
    expect(evaluateWhen({ branch: "client/*", newerThan: "1d" }, context).passed).toBe(true);
    expect(evaluateWhen({ branch: "other/*", newerThan: "1d" }, context).passed).toBe(false);
  });

  it("requires every named environment variable to equal its given value", () => {
    const context = { ...baseContext, env: { CI: "1", STAGE: "prod" } };
    expect(evaluateWhen({ env: { CI: "1" } }, context).passed).toBe(true);
    expect(evaluateWhen({ env: { CI: "1", STAGE: "prod" } }, context).passed).toBe(true);
    expect(evaluateWhen({ env: { CI: "1", STAGE: "dev" } }, context).passed).toBe(false);
    expect(evaluateWhen({ env: { MISSING: "x" } }, context).passed).toBe(false);
  });

  it("reports which fields it checked and which of those failed", () => {
    const result = evaluateWhen({ branch: "nope", env: { CI: "1" } }, { ...baseContext, branch: "main", env: { CI: "1" } });
    expect(result.checked).toEqual(["branch", "env"]);
    expect(result.failed).toEqual(["branch"]);
  });

  it("fails a size or age condition when there is no entry fact to read", () => {
    expect(evaluateWhen({ newerThan: "1d" }, baseContext).passed).toBe(false);
    expect(evaluateWhen({ maxSizeBytes: 10 }, baseContext).passed).toBe(false);
  });
});

// Comfortably outside the 90-day window every newerThan/olderThan test below checks against.
const STALE_AGE_DAYS = 200;

describe("newerThan and olderThan", () => {
  const fresh = fact({ latestMtimeMs: FAKE_NOW_MS - 1 * DAY_MS });
  const stale = fact({ latestMtimeMs: FAKE_NOW_MS - STALE_AGE_DAYS * DAY_MS });

  it("includes a fresh entry and excludes a stale one under the same window", () => {
    expect(evaluateWhen({ newerThan: "90d" }, { ...baseContext, fact: fresh }).passed).toBe(true);
    expect(evaluateWhen({ newerThan: "90d" }, { ...baseContext, fact: stale }).passed).toBe(false);
  });

  it("inverts exactly, so olderThan and newerThan never both hold for the same entry and window", () => {
    for (const entry of [fresh, stale]) {
      const newer = evaluateWhen({ newerThan: "90d" }, { ...baseContext, fact: entry }).passed;
      const older = evaluateWhen({ olderThan: "90d" }, { ...baseContext, fact: entry }).passed;
      expect(newer).not.toBe(older);
    }
  });
});

// Well outside the 90-day newerThan window the "reads the subtree" tests check against -- the whole point of the test is that this ancient directory-own mtime must not be what evaluateWhen sees.
const ANCIENT_DIR_MTIME_AGE_DAYS = 400;

describe("directory-scoped conditions read the subtree, not the directory's own inode", () => {
  it("uses the subtree's most recent mtime for newerThan", () => {
    // The directory's own mtime is ancient; a file three levels down was written today. A naive stat of the directory itself would wrongly conclude the whole subtree is stale.
    const facts = makeFacts({
      "projects/-a-b": { dir: true, mtimeMs: FAKE_NOW_MS - ANCIENT_DIR_MTIME_AGE_DAYS * DAY_MS },
      "projects/-a-b/nested/session.jsonl": { mtimeMs: FAKE_NOW_MS - 1 * DAY_MS, sizeBytes: 10 },
    });
    const directory = facts.entries.get("projects/-a-b");
    expect(directory?.mtimeMs).toBe(FAKE_NOW_MS - ANCIENT_DIR_MTIME_AGE_DAYS * DAY_MS);
    expect(directory?.latestMtimeMs).toBe(FAKE_NOW_MS - 1 * DAY_MS);
    expect(evaluateWhen({ newerThan: "90d" }, { ...baseContext, ...(directory === undefined ? {} : { fact: directory }) }).passed).toBe(
      true,
    );
  });

  it("uses the subtree's recursive total size for maxSizeBytes", () => {
    const dirOwnSizeBytes = 4_096;
    const fileOneSizeBytes = 5_000;
    const fileTwoSizeBytes = 6_000;
    const facts = makeFacts({
      "projects/-a-b": { dir: true, sizeBytes: dirOwnSizeBytes },
      "projects/-a-b/one.jsonl": { sizeBytes: fileOneSizeBytes },
      "projects/-a-b/two.jsonl": { sizeBytes: fileTwoSizeBytes },
    });
    const directory = facts.entries.get("projects/-a-b");
    expect(directory?.sizeBytes).toBe(dirOwnSizeBytes);
    expect(directory?.totalSizeBytes).toBe(dirOwnSizeBytes + fileOneSizeBytes + fileTwoSizeBytes);
    const context = { ...baseContext, ...(directory === undefined ? {} : { fact: directory }) };
    expect(evaluateWhen({ maxSizeBytes: 10_000 }, context).passed).toBe(false);
    expect(evaluateWhen({ maxSizeBytes: 20_000 }, context).passed).toBe(true);
  });
});

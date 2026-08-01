import { describe, expect, it } from "vitest";

import {
  canonicaliseEntryKey,
  compareSpecificity,
  compileMatcher,
  EntryKeyError,
  isExactPattern,
  literalPrefixOf,
  normaliseRelative,
  patternCouldReachUnder,
} from "./match";
import type { CompiledRule } from "./types";

// A fake home directory. Deliberately not the real one: nothing in this project's tests may resolve to a path anyone actually uses.
const home = "/home/testuser";

function rule(overrides: Partial<CompiledRule> & { canonicalPattern: string; layer: number; ordinal: number }): CompiledRule {
  const pattern = overrides.canonicalPattern;
  return {
    rawKey: `knowledge/${pattern}`,
    declaredCategory: "knowledge",
    value: true,
    isExact: isExactPattern(pattern),
    literalPrefix: literalPrefixOf(pattern),
    segmentCount: pattern.split("/").filter((segment) => segment !== "").length,
    matches: compileMatcher(pattern),
    ...overrides,
  };
}

describe("canonicaliseEntryKey", () => {
  it("strips the category prefix and keeps the rest as written", () => {
    expect(canonicaliseEntryKey("knowledge/skills/commit", { home })).toEqual({
      declaredCategory: "knowledge",
      canonicalPattern: "skills/commit",
    });
  });

  it("keeps the declared category so the resolver can cross-check it against the real classification", () => {
    expect(canonicaliseEntryKey("runtime/.credentials.json", { home }).declaredCategory).toBe("runtime");
  });

  it("encodes a history/projects/ fragment as a real path, since that directory's only children are encoded names", () => {
    const canonical = canonicaliseEntryKey("history/projects/~/work/clients/*", { home });
    expect(canonical.canonicalPattern).toBe("projects/-home-testuser-work-clients-*");
    expect(canonical.projectFragment).toBe("~/work/clients/*");
  });

  it("applies the project encoding nowhere else — every other key is a literal path or an ordinary glob", () => {
    expect(canonicaliseEntryKey("history/sessions/~weird", { home }).canonicalPattern).toBe("sessions/~weird");
    expect(canonicaliseEntryKey("knowledge/skills/a.b.c", { home }).canonicalPattern).toBe("skills/a.b.c");
  });

  it("normalises redundant separators and `.` segments outside history/projects/", () => {
    expect(normaliseRelative("skills//commit/")).toBe("skills/commit");
    expect(canonicaliseEntryKey("knowledge/./skills//commit/", { home }).canonicalPattern).toBe("skills/commit");
  });

  it("rejects a key with no category prefix", () => {
    expect(() => canonicaliseEntryKey("skills/commit-only", { home })).toThrow(EntryKeyError);
  });

  it("rejects a history/projects/ fragment that is not rooted", () => {
    expect(() => canonicaliseEntryKey("history/projects/work/acme", { home })).toThrow(EntryKeyError);
  });

  it("collapses two syntactically different but equivalent project keys to one canonical pattern", () => {
    const viaTilde = canonicaliseEntryKey("history/projects/~/work/x", { home });
    const viaAbsolute = canonicaliseEntryKey(`history/projects/${home}/work/x`, { home });
    expect(viaTilde.canonicalPattern).toBe(viaAbsolute.canonicalPattern);
  });
});

describe("compileMatcher", () => {
  it("matches the pattern itself and everything beneath it, so a rule on a directory covers its contents", () => {
    const matches = compileMatcher("skills");
    expect(matches("skills")).toBe(true);
    expect(matches("skills/commit")).toBe(true);
    expect(matches("skills/commit/SKILL.md")).toBe(true);
    expect(matches("agents")).toBe(false);
  });

  it("covers the contents of a glob-matched directory too", () => {
    const matches = compileMatcher("projects/-a-b-*");
    expect(matches("projects/-a-b-c")).toBe(true);
    expect(matches("projects/-a-b-c/session.jsonl")).toBe(true);
    expect(matches("projects/-x-y-z")).toBe(false);
  });

  it("matches a leading-dot entry, which a glob would otherwise skip", () => {
    expect(compileMatcher(".git*")(".gitignore")).toBe(true);
  });

  it("matches case-sensitively whatever the host filesystem does", () => {
    expect(compileMatcher("skills")("Skills")).toBe(false);
  });
});

describe("patternCouldReachUnder", () => {
  it.each([
    ["projects/*", "projects", true],
    ["projects/-a-*", "projects", true],
    ["projects", "projects", true],
    ["projects/-a-b", "projects", true],
    ["skills/**", "projects", false],
    ["skills/commit", "skills", true],
    ["skills/commit", "agents", false],
    ["**", "anything/deep", true],
    ["skills", "skills/commit", true],
    ["a/*/c", "a/b", true],
    ["a/*/c", "z/b", false],
  ])("says %s could reach under %s: %s", (pattern, dir, expected) => {
    expect(patternCouldReachUnder(pattern, dir)).toBe(expected);
  });

  it("answers structurally rather than from the current listing, so it holds for files that do not exist yet", () => {
    // Nothing named `projects/-new-path-written-tomorrow` exists anywhere in any fixture; the answer still has to be yes.
    expect(patternCouldReachUnder("projects/*", "projects")).toBe(true);
  });
});

describe("compareSpecificity", () => {
  it("ranks a later layer above an earlier one, whatever their exactness", () => {
    const earlierExact = rule({ canonicalPattern: "skills/commit", layer: 1, ordinal: 0 });
    const laterGlob = rule({ canonicalPattern: "skills/*", layer: 3, ordinal: 0 });
    expect(compareSpecificity(laterGlob, earlierExact)).toBeGreaterThan(0);
    expect(compareSpecificity(earlierExact, laterGlob)).toBeLessThan(0);
  });

  it("ranks an exact literal above a glob within the same layer", () => {
    const exact = rule({ canonicalPattern: "skills/commit", layer: 2, ordinal: 1 });
    const glob = rule({ canonicalPattern: "skills/*", layer: 2, ordinal: 0 });
    expect(compareSpecificity(exact, glob)).toBeGreaterThan(0);
  });

  it("ranks the longer literal prefix above the shorter one within the same layer", () => {
    const longer = rule({ canonicalPattern: "projects/-a-b-c*", layer: 2, ordinal: 0 });
    const shorter = rule({ canonicalPattern: "projects/*", layer: 2, ordinal: 1 });
    expect(compareSpecificity(longer, shorter)).toBeGreaterThan(0);
  });

  it("ranks more path segments above fewer, separating a one-wildcard pattern from a two-wildcard one", () => {
    const deeper = rule({ canonicalPattern: "a/*/*", layer: 2, ordinal: 0 });
    const shallower = rule({ canonicalPattern: "a/*", layer: 2, ordinal: 1 });
    expect(compareSpecificity(deeper, shallower)).toBeGreaterThan(0);
  });

  it("falls back to source order within one layer when everything else ties", () => {
    const first = rule({ canonicalPattern: "a/*", layer: 2, ordinal: 0 });
    const second = rule({ canonicalPattern: "b/*", layer: 2, ordinal: 1 });
    expect(compareSpecificity(second, first)).toBeGreaterThan(0);
  });

  it("is a total order — it never returns 0 for two distinct rules, which would make the winner iteration-order-dependent", () => {
    const candidates = [
      rule({ canonicalPattern: "a/*", layer: 0, ordinal: 0 }),
      rule({ canonicalPattern: "a/b", layer: 0, ordinal: 0 }),
      rule({ canonicalPattern: "b/*", layer: 1, ordinal: 0 }),
      rule({ canonicalPattern: "a/*/*", layer: 1, ordinal: 3 }),
      rule({ canonicalPattern: "aa/*", layer: 1, ordinal: 3 }),
    ];
    for (const a of candidates) {
      for (const b of candidates) {
        if (a === b) {
          expect(compareSpecificity(a, b)).toBe(0);
          continue;
        }
        expect(compareSpecificity(a, b)).not.toBe(0);
        expect(Math.sign(compareSpecificity(a, b))).toBe(-Math.sign(compareSpecificity(b, a)));
      }
    }
  });

  it("sorts identically regardless of the order the candidates arrive in", () => {
    const candidates = [
      rule({ canonicalPattern: "a/b", layer: 0, ordinal: 0 }),
      rule({ canonicalPattern: "a/*", layer: 2, ordinal: 1 }),
      rule({ canonicalPattern: "a/*/*", layer: 2, ordinal: 0 }),
    ];
    const forwards = [...candidates].sort((a, b) => compareSpecificity(b, a)).map((r) => r.canonicalPattern);
    const backwards = [...candidates].reverse().sort((a, b) => compareSpecificity(b, a)).map((r) => r.canonicalPattern);
    expect(forwards).toEqual(backwards);
  });
});

describe("literalPrefixOf", () => {
  it.each([
    ["skills/commit", "skills/commit"],
    ["projects/-a-b-*", "projects/-a-b-"],
    ["*", ""],
    ["a/**/b", "a/"],
  ])("reads the literal prefix of %s as %s", (pattern, prefix) => {
    expect(literalPrefixOf(pattern)).toBe(prefix);
  });
});

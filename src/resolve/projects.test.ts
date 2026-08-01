import { describe, expect, it } from "vitest";

import * as projects from "./projects";
import {
  detectEncodingAmbiguity,
  encodeProjectPath,
  encodeProjectPattern,
  expandHome,
  splitOnWildcards,
  UnrootedProjectPathError,
} from "./projects";

const home = "/Users/alice";

describe("encodeProjectPath", () => {
  it.each([
    ["/Users/alice/work/clients/acme", "-Users-alice-work-clients-acme"],
    ["/Users/alice/dev/app-v1.2.3", "-Users-alice-dev-app-v1-2-3"],
    ["/Users/alice/My Documents/notes", "-Users-alice-My-Documents-notes"],
    ["/Users/alice/some_dir/other_thing", "-Users-alice-some-dir-other-thing"],
    ["/Users/alice/@scope/pkg", "-Users-alice--scope-pkg"],
    ["/Users/alice/CamelCase/9lives", "-Users-alice-CamelCase-9lives"],
  ])("collapses the whole non-alphanumeric class in %s", (real, encoded) => {
    expect(encodeProjectPath(real)).toBe(encoded);
  });

  it("preserves case rather than lowercasing", () => {
    expect(encodeProjectPath("/A/b/CdE")).toBe("-A-b-CdE");
  });

  it("collapses `.` and `_` and ` ` exactly as it collapses `/`, which is what makes the encoding many-to-one", () => {
    expect(encodeProjectPath("/a/b-c")).toBe(encodeProjectPath("/a-b-c"));
    expect(encodeProjectPath("/a/b.c")).toBe(encodeProjectPath("/a/b/c"));
  });
});

describe("splitOnWildcards", () => {
  it("keeps wildcard tokens out of the literal runs, so encoding never turns a `*` into a `-`", () => {
    expect(splitOnWildcards("/a/b/*")).toEqual([
      { kind: "literal", text: "/a/b/" },
      { kind: "wildcard", text: "*" },
    ]);
  });

  it("treats `**` as one token rather than two `*`", () => {
    expect(splitOnWildcards("/a/**/b")).toEqual([
      { kind: "literal", text: "/a/" },
      { kind: "wildcard", text: "**" },
      { kind: "literal", text: "/b" },
    ]);
  });

  it("handles `?` and adjacent wildcards", () => {
    expect(splitOnWildcards("?*x")).toEqual([
      { kind: "wildcard", text: "?" },
      { kind: "wildcard", text: "*" },
      { kind: "literal", text: "x" },
    ]);
  });
});

describe("expandHome", () => {
  it("expands a leading `~/`", () => {
    expect(expandHome("~/work", home)).toBe("/Users/alice/work");
  });

  it("expands a bare `~`", () => {
    expect(expandHome("~", home)).toBe(home);
  });

  it("leaves a `~` that is not the first character alone", () => {
    expect(expandHome("/a/~b", home)).toBe("/a/~b");
  });

  it("does not expand `~name`, which is another user's home, not this one's", () => {
    expect(expandHome("~bob/work", home)).toBe("~bob/work");
  });
});

describe("encodeProjectPattern", () => {
  it("expands `~` before encoding, never after — encoding first would turn the `~` into a `-` and lose the reference", () => {
    expect(encodeProjectPattern("~/work/clients/acme", { home })).toBe("-Users-alice-work-clients-acme");
    expect(encodeProjectPattern("~/work/clients/acme", { home })).toBe(encodeProjectPath(`${home}/work/clients/acme`));
  });

  it("carries wildcard tokens through encoding as wildcards", () => {
    expect(encodeProjectPattern("~/work/clients/*", { home })).toBe("-Users-alice-work-clients-*");
    expect(encodeProjectPattern("~/work/**", { home })).toBe("-Users-alice-work-**");
    expect(encodeProjectPattern("/a/?/b", { home })).toBe("-a-?-b");
  });

  it("encodes an absolute path with no `~` at all", () => {
    expect(encodeProjectPattern("/var/tmp/x", { home })).toBe("-var-tmp-x");
  });

  it("rejects a fragment that is neither home-rooted nor absolute", () => {
    expect(() => encodeProjectPattern("work/clients/acme", { home })).toThrow(UnrootedProjectPathError);
    expect(() => encodeProjectPattern("*", { home })).toThrow(UnrootedProjectPathError);
  });

  it.each([
    ["~/dev/app-v1.2.3", "-Users-alice-dev-app-v1-2-3"],
    ["~/My Documents", "-Users-alice-My-Documents"],
    ["~/some_dir", "-Users-alice-some-dir"],
    ["~/@scope", "-Users-alice--scope"],
  ])("encodes %s to %s", (fragment, expected) => {
    expect(encodeProjectPattern(fragment, { home })).toBe(expected);
  });
});

describe("detectEncodingAmbiguity", () => {
  it("flags a literal containing a character besides `/` that encodes to `-`", () => {
    const found = detectEncodingAmbiguity(["~/work/app-v1.2"], { home });
    expect(found.map((ambiguity) => ambiguity.reason)).toContain("lossy-characters");
  });

  it("does not flag a literal whose only lossy characters are separators", () => {
    expect(detectEncodingAmbiguity(["~/work/clients/acme"], { home })).toEqual([]);
  });

  it("flags two distinct fragments that encode identically, which proves a collision outright", () => {
    const found = detectEncodingAmbiguity(["/work/clients/acme", "/work/clients-acme"], { home });
    const collisions = found.filter((ambiguity) => ambiguity.reason === "collides-with-sibling-pattern");
    expect(collisions).toHaveLength(2);
    expect(collisions[0]?.encoded).toBe("-work-clients-acme");
  });

  it("reports how many real project directories the encoded form currently matches, when given the listing", () => {
    const found = detectEncodingAmbiguity(["~/work/app.v1"], {
      home,
      existingNames: ["-Users-alice-work-app-v1", "-Users-alice-other"],
    });
    expect(found[0]?.detail).toContain("matches 1 existing project directory name(s)");
  });

  it("skips a fragment it cannot encode rather than throwing mid-report", () => {
    expect(detectEncodingAmbiguity(["not-rooted"], { home })).toEqual([]);
  });
});

describe("module surface", () => {
  it("exports no decode function of any kind — the encoding is many-to-one and must never be inverted", () => {
    const decoders = Object.keys(projects).filter((name) => /decode|invert|reverse|toRealPath/i.test(name));
    expect(decoders).toEqual([]);
  });
});

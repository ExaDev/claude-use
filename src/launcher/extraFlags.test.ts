import { describe, expect, it } from "vitest";

import { splitExtraFlags } from "./extraFlags";

describe("splitExtraFlags", () => {
  it("produces zero argv entries when unset", () => {
    expect(splitExtraFlags(undefined)).toEqual([]);
  });

  it("produces zero argv entries when empty, not one empty-string entry", () => {
    expect(splitExtraFlags("")).toEqual([]);
  });

  it("produces zero argv entries for a whitespace-only value", () => {
    expect(splitExtraFlags("   ")).toEqual([]);
  });

  it("splits a two-token flag+value pair into two argv entries — the cccc/mcc/occ/zcc/scc shape", () => {
    expect(splitExtraFlags("--continue continue")).toEqual(["--continue", "continue"]);
  });

  it("splits a single flag into one argv entry — the cpl/mp/zpl shape", () => {
    expect(splitExtraFlags("--print")).toEqual(["--print"]);
  });

  it("collapses runs of whitespace between tokens", () => {
    expect(splitExtraFlags("--continue    continue")).toEqual(["--continue", "continue"]);
  });

  it("trims leading and trailing whitespace", () => {
    expect(splitExtraFlags("  --print  ")).toEqual(["--print"]);
  });

  it("splits on tabs as well as spaces", () => {
    expect(splitExtraFlags("--continue\tcontinue")).toEqual(["--continue", "continue"]);
  });
});

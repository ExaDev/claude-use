import { describe, expect, it } from "vitest";

import {
  collectBoolPairs,
  parseBoolPairList,
  parseBoolStrict,
  parsePair,
  splitTopLevelCommas,
} from "./parsers";

describe("splitTopLevelCommas", () => {
  it("splits a plain comma-separated list", () => {
    expect(splitTopLevelCommas("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array for an empty string, not [\"\"]", () => {
    expect(splitTopLevelCommas("")).toEqual([]);
  });

  it("returns a single-element array for input with no comma", () => {
    expect(splitTopLevelCommas("solo")).toEqual(["solo"]);
  });

  it("preserves empty pieces from a trailing comma", () => {
    expect(splitTopLevelCommas("a,b,")).toEqual(["a", "b", ""]);
  });

  it("preserves empty pieces from a leading comma", () => {
    expect(splitTopLevelCommas(",a,b")).toEqual(["", "a", "b"]);
  });

  it("preserves empty pieces from consecutive commas", () => {
    expect(splitTopLevelCommas("a,,b")).toEqual(["a", "", "b"]);
  });
});

describe("parsePair", () => {
  it("splits a simple key=value", () => {
    expect(parsePair("history=true")).toEqual({ key: "history", value: "true" });
  });

  it("splits only on the first =, leaving further = characters in the value", () => {
    expect(parsePair("knowledge/skills/foo=bar=baz")).toEqual({
      key: "knowledge/skills/foo",
      value: "bar=baz",
    });
  });

  it("allows an empty value", () => {
    expect(parsePair("history=")).toEqual({ key: "history", value: "" });
  });

  it("throws when there is no = at all", () => {
    expect(() => parsePair("history")).toThrow(/no "=" found/);
  });

  it("throws when the key half is empty", () => {
    expect(() => parsePair("=true")).toThrow(/non-empty key/);
  });

  it("throws for a completely empty string", () => {
    expect(() => parsePair("")).toThrow(/no "=" found/);
  });
});

describe("parseBoolStrict", () => {
  it("parses true", () => {
    expect(parseBoolStrict("true")).toBe(true);
  });

  it("parses false", () => {
    expect(parseBoolStrict("false")).toBe(false);
  });

  it.each(["True", "FALSE", "1", "0", "yes", "no", "", " true", "true "])(
    "rejects %j — no case-insensitivity, coercion, or whitespace tolerance",
    (input) => {
      expect(() => parseBoolStrict(input)).toThrow(/Expected "true" or "false"/);
    },
  );
});

describe("parseBoolPairList", () => {
  it("parses a multi-entry list", () => {
    expect(parseBoolPairList("history=true,knowledge=false")).toEqual({
      history: true,
      knowledge: false,
    });
  });

  it("parses a single-entry list", () => {
    expect(parseBoolPairList("history=true")).toEqual({ history: true });
  });

  it("parses an empty string to an empty object", () => {
    expect(parseBoolPairList("")).toEqual({});
  });

  it("lets a later duplicate key in the same list win", () => {
    expect(parseBoolPairList("history=true,history=false")).toEqual({ history: false });
  });

  it("throws when any single pair in the list is malformed", () => {
    expect(() => parseBoolPairList("history=true,knowledge")).toThrow(/no "=" found/);
  });

  it("throws when any single pair's value is not a strict boolean", () => {
    expect(() => parseBoolPairList("history=yes")).toThrow(/Expected "true" or "false"/);
  });

  it("parses a path-shaped entry key", () => {
    expect(parseBoolPairList("knowledge/skills/commit=true")).toEqual({
      "knowledge/skills/commit": true,
    });
  });
});

describe("collectBoolPairs", () => {
  it("starts from an empty object when no previous value is given", () => {
    expect(collectBoolPairs("history=true")).toEqual({ history: true });
  });

  it("merges a new invocation's pairs over a previous accumulated object", () => {
    const first = collectBoolPairs("history=true");
    const second = collectBoolPairs("knowledge=false", first);
    expect(second).toEqual({ history: true, knowledge: false });
  });

  it("lets a later invocation's key win over an earlier one", () => {
    const first = collectBoolPairs("history=true");
    const second = collectBoolPairs("history=false", first);
    expect(second).toEqual({ history: false });
  });

  it("never mutates the previous object it was given", () => {
    const first = collectBoolPairs("history=true");
    const frozenCopy = { ...first };
    collectBoolPairs("knowledge=false", first);
    expect(first).toEqual(frozenCopy);
  });

  it("accumulates across three invocations, matching three separate --category flags", () => {
    let acc: Record<string, boolean> = {};
    acc = collectBoolPairs("history=true", acc);
    acc = collectBoolPairs("knowledge=false", acc);
    acc = collectBoolPairs("settings=true", acc);
    expect(acc).toEqual({ history: true, knowledge: false, settings: true });
  });
});

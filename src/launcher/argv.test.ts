import { describe, expect, it } from "vitest";

import { parseLauncherArgv } from "./argv";

describe("parseLauncherArgv", () => {
  it("consumes a leading @name and strips it from rest", () => {
    const result = parseLauncherArgv(["@work", "--print", "hello"]);
    expect(result.identity).toBe("work");
    expect(result.rest).toEqual(["--print", "hello"]);
  });

  it("never treats an @-prefixed token as an identity anywhere other than index 0", () => {
    const result = parseLauncherArgv(["--print", "@notidentity", "hello"]);
    expect(result.identity).toBeUndefined();
    expect(result.rest).toEqual(["--print", "@notidentity", "hello"]);
  });

  it("returns no identity and the argv unchanged when nothing is present", () => {
    const result = parseLauncherArgv([]);
    expect(result.identity).toBeUndefined();
    expect(result.rest).toEqual([]);
  });

  it("does not treat a bare @ with nothing after it as an identity token", () => {
    const result = parseLauncherArgv(["@", "--print"]);
    expect(result.identity).toBeUndefined();
    expect(result.rest).toEqual(["@", "--print"]);
  });

  it("passes through a normal first positional untouched", () => {
    const result = parseLauncherArgv(["/loop continue"]);
    expect(result.identity).toBeUndefined();
    expect(result.rest).toEqual(["/loop continue"]);
  });

  it("strips only the single leading @name token, not any later one even if also @-prefixed", () => {
    const result = parseLauncherArgv(["@personal", "@work", "--print"]);
    expect(result.identity).toBe("personal");
    expect(result.rest).toEqual(["@work", "--print"]);
  });
});

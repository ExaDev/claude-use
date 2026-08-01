import { describe, expect, it } from "vitest";

import { buildArgv, buildEnv, buildFlagArgs, resolveLaunchFlags } from "./flags";

describe("resolveLaunchFlags", () => {
  it("defaults both flags to off when nothing sets them — a deliberate change from the legacy always-on script", () => {
    expect(resolveLaunchFlags({ env: {} })).toEqual({ skipPermissions: false, remoteControl: false });
  });

  it("turns skipPermissions on via the CLAUDE_USE_SKIP_PERMISSIONS=1 escape hatch", () => {
    expect(resolveLaunchFlags({ env: { CLAUDE_USE_SKIP_PERMISSIONS: "1" } })).toEqual({
      skipPermissions: true,
      remoteControl: false,
    });
  });

  it("turns remoteControl on via the CLAUDE_USE_REMOTE_CONTROL=1 escape hatch", () => {
    expect(resolveLaunchFlags({ env: { CLAUDE_USE_REMOTE_CONTROL: "1" } })).toEqual({
      skipPermissions: false,
      remoteControl: true,
    });
  });

  it("does not treat any value other than the literal string '1' as set", () => {
    expect(
      resolveLaunchFlags({ env: { CLAUDE_USE_SKIP_PERMISSIONS: "true", CLAUDE_USE_REMOTE_CONTROL: "0" } }),
    ).toEqual({ skipPermissions: false, remoteControl: false });
  });

  it("honours a cascade value once one is supplied, independent of the env escape hatch", () => {
    expect(resolveLaunchFlags({ env: {}, cascade: { skipPermissions: true, remoteControl: true } })).toEqual({
      skipPermissions: true,
      remoteControl: true,
    });
  });

  it("ORs the cascade value with the env escape hatch rather than one overriding the other", () => {
    expect(
      resolveLaunchFlags({ env: { CLAUDE_USE_REMOTE_CONTROL: "1" }, cascade: { skipPermissions: true } }),
    ).toEqual({ skipPermissions: true, remoteControl: true });
  });
});

describe("buildFlagArgs", () => {
  it("emits nothing when both flags are off", () => {
    expect(buildFlagArgs({ skipPermissions: false, remoteControl: false })).toEqual([]);
  });

  it("emits --dangerously-skip-permissions when skipPermissions is on", () => {
    expect(buildFlagArgs({ skipPermissions: true, remoteControl: false })).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });

  it("emits --remote-control= with a literal trailing equals and empty value, never bare --remote-control", () => {
    const args = buildFlagArgs({ skipPermissions: false, remoteControl: true });
    expect(args).toEqual(["--remote-control="]);
    expect(args).not.toContain("--remote-control");
  });

  it("emits both flags, skip-permissions before remote-control, matching the legacy script's own order", () => {
    expect(buildFlagArgs({ skipPermissions: true, remoteControl: true })).toEqual([
      "--dangerously-skip-permissions",
      "--remote-control=",
    ]);
  });
});

describe("buildArgv", () => {
  it("orders tool flags, then extra flags, then passthrough args", () => {
    expect(
      buildArgv({
        toolFlags: ["--dangerously-skip-permissions", "--remote-control="],
        extraFlags: ["--continue", "continue"],
        passthrough: ["--verbose"],
      }),
    ).toEqual(["--dangerously-skip-permissions", "--remote-control=", "--continue", "continue", "--verbose"]);
  });

  it("puts extra flags before a positional passthrough prompt — the cpl/mp/zpl shape (--print then a trailing prompt)", () => {
    expect(
      buildArgv({ toolFlags: [], extraFlags: ["--print"], passthrough: ["/loop continue"] }),
    ).toEqual(["--print", "/loop continue"]);
  });

  it("returns an empty argv when nothing is present anywhere", () => {
    expect(buildArgv({ toolFlags: [], extraFlags: [], passthrough: [] })).toEqual([]);
  });
});

describe("buildEnv", () => {
  const baseEnv = { PATH: "/usr/bin", HOME: "/home/testuser" };

  it("leaves the environment unchanged when the CLAUDE_CONFIG_DIR escape hatch applied", () => {
    const env = buildEnv({
      baseEnv: { ...baseEnv, CLAUDE_CONFIG_DIR: "/somewhere/else" },
      configDirEscapeHatch: true,
      resolvedIdentityName: "work",
      identitiesDir: "/home/testuser/.claude-use/identities",
    });
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/somewhere/else");
  });

  it("leaves the environment unchanged when no identity was resolved at all", () => {
    const env = buildEnv({
      baseEnv,
      configDirEscapeHatch: false,
      identitiesDir: "/home/testuser/.claude-use/identities",
    });
    expect(env).toEqual(baseEnv);
    expect(env["CLAUDE_CONFIG_DIR"]).toBeUndefined();
  });

  it("sets CLAUDE_CONFIG_DIR to the resolved identity's own directory otherwise", () => {
    const env = buildEnv({
      baseEnv,
      configDirEscapeHatch: false,
      resolvedIdentityName: "work",
      identitiesDir: "/home/testuser/.claude-use/identities",
    });
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/home/testuser/.claude-use/identities/work");
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("never strips CLAUDE_EXTRA_FLAGS from the child environment", () => {
    const env = buildEnv({
      baseEnv: { ...baseEnv, CLAUDE_EXTRA_FLAGS: "--continue continue" },
      configDirEscapeHatch: false,
      resolvedIdentityName: "work",
      identitiesDir: "/home/testuser/.claude-use/identities",
    });
    expect(env["CLAUDE_EXTRA_FLAGS"]).toBe("--continue continue");
  });
});

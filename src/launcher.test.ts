import { describe, expect, it, vi } from "vitest";

import { runLauncher, type RunLauncherParams } from "./launcher";
import type { FsPort, LogPort, ProcPort, SpawnPort, SpawnResult } from "./launcher/ports";
import { buildLayoutPaths } from "./paths";
import type { DiscoveredClaudeBinary } from "./versionDiscovery";

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process would exit with code ${code}`);
  }
}

const paths = buildLayoutPaths("/home/testuser/.claude-use");

function fakeProc(env: Record<string, string | undefined>, argv: string[]): ProcPort {
  return {
    env,
    argv,
    exit: (code: number): never => {
      throw new ExitCalled(code);
    },
  };
}

function fakeFs(files: Record<string, unknown | string>): FsPort {
  return {
    readFileUtf8: (filePath) => {
      const value = files[filePath];
      return typeof value === "string" ? value : undefined;
    },
    readConfigFile: (filePath) => {
      const value = files[filePath];
      return value === undefined || typeof value === "string" ? undefined : value;
    },
  };
}

function fakeLog(): LogPort & { infos: string[]; warns: string[]; errors: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    warns,
    errors,
    info: (message) => infos.push(message),
    warn: (message) => warns.push(message),
    error: (message) => errors.push(message),
  };
}

function fakeSpawn(result: SpawnResult = { status: 0, signal: null }): SpawnPort & { spawnSync: ReturnType<typeof vi.fn> } {
  return { spawnSync: vi.fn().mockReturnValue(result) };
}

const discovered: DiscoveredClaudeBinary = { path: "/home/testuser/.local/share/claude/versions/2.1.0", source: "versions-dir", version: "2.1.0" };

function runAndCaptureExit(params: RunLauncherParams): number {
  try {
    runLauncher(params);
  } catch (error) {
    if (error instanceof ExitCalled) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected runLauncher to reach spawnClaude's proc.exit");
}

describe("runLauncher", () => {
  it("refuses to launch and never spawns when the ambient-credential guard fails", () => {
    const proc = fakeProc({ ANTHROPIC_API_KEY: "sk-real-key" }, []);
    const log = fakeLog();
    const spawn = fakeSpawn();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(1);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toContain("ANTHROPIC_API_KEY");
  });

  it("spawns with the real claude binary and default-off flags on a bare launch with no identity", () => {
    const proc = fakeProc({}, ["--print", "hello"]);
    const log = fakeLog();
    const spawn = fakeSpawn();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(0);
    expect(spawn.spawnSync).toHaveBeenCalledWith(discovered.path, ["--print", "hello"], {
      stdio: "inherit",
      env: {},
    });
  });

  it("strips a leading @name identity token and sets CLAUDE_CONFIG_DIR to that identity's own directory", () => {
    const proc = fakeProc({}, ["@work", "--print"]);
    const log = fakeLog();
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(spawn.spawnSync).toHaveBeenCalledWith(
      discovered.path,
      ["--print"],
      { stdio: "inherit", env: { CLAUDE_CONFIG_DIR: "/home/testuser/.claude-use/identities/work" } },
    );
  });

  it("leaves CLAUDE_CONFIG_DIR untouched and still runs the ambient-credential guard when the escape hatch applies", () => {
    const proc = fakeProc(
      { CLAUDE_CONFIG_DIR: "/somewhere/explicit", ANTHROPIC_API_KEY: "sk-real-key" },
      ["@work", "--print"],
    );
    const log = fakeLog();
    const spawn = fakeSpawn();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    // The guard still fires even though CLAUDE_CONFIG_DIR is already set — it's a credential-isolation check, not an identity/config-dir selection check, so it is not bypassed by the escape hatch.
    expect(code).toBe(1);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
  });

  it("spawns with the already-set CLAUDE_CONFIG_DIR untouched once the guard passes under the escape hatch", () => {
    const proc = fakeProc({ CLAUDE_CONFIG_DIR: "/somewhere/explicit" }, ["@work", "--print"]);
    const log = fakeLog();
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(spawn.spawnSync).toHaveBeenCalledWith(discovered.path, ["--print"], {
      stdio: "inherit",
      env: { CLAUDE_CONFIG_DIR: "/somewhere/explicit" },
    });
  });

  it("allows an ambient credential through when the loaded identity's own allowAmbientCredential is true", () => {
    const proc = fakeProc({ ANTHROPIC_API_KEY: "sk-real-key" }, ["@work", "--print"]);
    const log = fakeLog();
    const spawn = fakeSpawn();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({
        "/home/testuser/.claude-use/identities/work/identity.json": {
          name: "work",
          allowAmbientCredential: true,
        },
      }),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(0);
    expect(spawn.spawnSync).toHaveBeenCalled();
  });

  it("warns but proceeds when the resolved identity has no identity.json on disk yet", () => {
    const proc = fakeProc({}, ["@ghost", "--print"]);
    const log = fakeLog();
    const spawn = fakeSpawn();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(0);
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]).toContain("ghost");
    expect(spawn.spawnSync).toHaveBeenCalled();
  });

  it("falls back to the persisted active-identity file when no argv/env/directory-pin identity applies", () => {
    const proc = fakeProc({}, ["--print"]);
    const log = fakeLog();
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({ "/home/testuser/.claude-use/active-identity": "personal\n" }),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(spawn.spawnSync).toHaveBeenCalledWith(discovered.path, ["--print"], {
      stdio: "inherit",
      env: { CLAUDE_CONFIG_DIR: "/home/testuser/.claude-use/identities/personal" },
    });
  });

  it("builds the final argv as toolFlags, then extraFlags, then passthrough, honouring both env-var flag escape hatches", () => {
    const proc = fakeProc(
      { CLAUDE_USE_SKIP_PERMISSIONS: "1", CLAUDE_USE_REMOTE_CONTROL: "1", CLAUDE_EXTRA_FLAGS: "--continue continue" },
      ["--verbose"],
    );
    const log = fakeLog();
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(spawn.spawnSync).toHaveBeenCalledWith(
      discovered.path,
      ["--dangerously-skip-permissions", "--remote-control=", "--continue", "continue", "--verbose"],
      { stdio: "inherit", env: expect.objectContaining({ CLAUDE_EXTRA_FLAGS: "--continue continue" }) },
    );
  });

  it("propagates the real binary's own exit code when spawning succeeds but the child exits non-zero", () => {
    const proc = fakeProc({}, []);
    const log = fakeLog();
    const spawn = fakeSpawn({ status: 2, signal: null });

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(2);
  });
});

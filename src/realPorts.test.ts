import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveOwnExecutablePath } from "./realPorts";

describe("resolveOwnExecutablePath", () => {
  const execPath = "/opt/homebrew/Cellar/claude-use/0.2.0/bin/claude-use";
  const cwd = "/Users/runner/work/claude-use/claude-use";

  it("falls back to execPath when argv1 is undefined", () => {
    const result = resolveOwnExecutablePath({
      argv1: undefined,
      execPath,
      cwd,
      pathDirs: [],
      findExecutableInDir: () => undefined,
    });
    expect(result).toBe(execPath);
  });

  it("resolves an absolute argv1 directly when its directory is itself on PATH", () => {
    const result = resolveOwnExecutablePath({
      argv1: "/opt/homebrew/bin/claude-use",
      execPath,
      cwd,
      pathDirs: ["/opt/homebrew/bin"],
      findExecutableInDir: () => {
        throw new Error("must not search PATH when the direct candidate's directory is already on PATH");
      },
    });
    expect(result).toBe("/opt/homebrew/bin/claude-use");
  });

  it("resolves a relative argv1 against cwd when cwd is on PATH", () => {
    const result = resolveOwnExecutablePath({
      argv1: "./claude-use",
      execPath,
      cwd,
      pathDirs: [cwd],
      findExecutableInDir: () => undefined,
    });
    expect(result).toBe(path.join(cwd, "claude-use"));
  });

  it("redirects to a separately PATH-visible entry when argv1's own directory isn't on PATH -- the Scoop re-exec case", () => {
    // Scoop's own shim (~/scoop/shims/claude-use.exe) is a compiled proxy that launches the real target -- living in a versioned app directory Scoop deliberately keeps off PATH -- as a child process, so this process's own argv1 is an absolute path outside every PATH entry. Confirmed against a real Scoop install: without this redirect, `shim enable` placed `claude.exe` next to the real target, in a directory PATH could never see. Expressed with POSIX-style separators here (rather than real Windows backslash paths) purely so the test is meaningful under whichever platform's native `path` module happens to run it -- the separate backslash-detection test above already covers the platform-specific separator character.
    const result = resolveOwnExecutablePath({
      argv1: "/Users/runneradmin/scoop/apps/claude-use/current/claude-use.exe",
      execPath,
      cwd: "/Users/runneradmin",
      pathDirs: ["/Users/runneradmin/scoop/shims"],
      findExecutableInDir: (dir, name) =>
        dir === "/Users/runneradmin/scoop/shims" && name === "claude-use.exe" ? "/Users/runneradmin/scoop/shims/claude-use.exe" : undefined,
    });
    expect(result).toBe("/Users/runneradmin/scoop/shims/claude-use.exe");
  });

  it("falls back to the direct candidate when its directory isn't on PATH and no PATH-visible entry exists either -- a fresh, not-yet-installed local build", () => {
    const directCandidate = "/Users/joe/dev/claude-use/dist/claude-use-sea";
    const result = resolveOwnExecutablePath({
      argv1: directCandidate,
      execPath,
      cwd: "/Users/joe/dev/claude-use",
      pathDirs: ["/usr/bin", "/opt/homebrew/bin"],
      findExecutableInDir: () => undefined,
    });
    expect(result).toBe(directCandidate);
  });

  it("searches PATH for a bare argv1 -- the SEA-binary-invoked-via-PATH-lookup case", () => {
    // This is the exact scenario that broke every release-verification job: a SEA binary invoked as a bare command found via PATH (e.g. typing `claude-use` at a shell prompt) gets argv1 === "claude-use", with no directory component at all -- confirmed empirically against a real built SEA binary, since Node's own docs only document the direct-invocation case, not this one.
    const pathDirs = ["/usr/bin", "/opt/homebrew/bin", "/other/dir"];
    const result = resolveOwnExecutablePath({
      argv1: "claude-use",
      execPath,
      cwd,
      pathDirs,
      findExecutableInDir: (dir, name) => (dir === "/opt/homebrew/bin" && name === "claude-use" ? "/opt/homebrew/bin/claude-use" : undefined),
    });
    expect(result).toBe("/opt/homebrew/bin/claude-use");
  });

  it("preserves a PATH-visible symlink rather than resolving through it -- the Homebrew Cellar-symlink case", () => {
    // findExecutableInDir returns whatever PATH-visible entry it found (which may itself be a symlink into a Cellar keg) -- resolveOwnExecutablePath must hand that back verbatim, not realpath it, since callers need the PATH-visible location to place a new file where PATH will actually find it.
    const result = resolveOwnExecutablePath({
      argv1: "claude-use",
      execPath,
      cwd,
      pathDirs: ["/opt/homebrew/bin"],
      findExecutableInDir: () => "/opt/homebrew/bin/claude-use",
    });
    expect(result).toBe("/opt/homebrew/bin/claude-use");
  });

  it("stops at the first PATH directory containing a match", () => {
    const seen: string[] = [];
    resolveOwnExecutablePath({
      argv1: "claude-use",
      execPath,
      cwd,
      pathDirs: ["/first", "/second", "/third"],
      findExecutableInDir: (dir) => {
        seen.push(dir);
        return dir === "/first" ? "/first/claude-use" : undefined;
      },
    });
    expect(seen).toEqual(["/first"]);
  });

  it("falls back to execPath when a bare argv1 isn't found anywhere on PATH", () => {
    const result = resolveOwnExecutablePath({
      argv1: "claude-use",
      execPath,
      cwd,
      pathDirs: ["/usr/bin", "/opt/homebrew/bin"],
      findExecutableInDir: () => undefined,
    });
    expect(result).toBe(execPath);
  });

  it("resolves a Windows-style backslash argv1 as a path, not a bare word", () => {
    const argv1 = "bin\\claude-use.exe";
    const winCwd = "C:\\Users\\runner\\work";
    const directCandidate = path.resolve(winCwd, argv1);
    const directDir = path.dirname(directCandidate);
    const result = resolveOwnExecutablePath({
      argv1,
      execPath,
      cwd: winCwd,
      pathDirs: [directDir],
      findExecutableInDir: () => {
        throw new Error("must not search PATH when the direct candidate's directory is already on PATH");
      },
    });
    expect(result).toBe(directCandidate);
  });
});

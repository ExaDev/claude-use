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

  it("resolves an absolute argv1 directly, without touching execPath or PATH", () => {
    const result = resolveOwnExecutablePath({
      argv1: "/opt/homebrew/bin/claude-use",
      execPath,
      cwd,
      pathDirs: [],
      findExecutableInDir: () => {
        throw new Error("must not search PATH when argv1 is already a path");
      },
    });
    expect(result).toBe("/opt/homebrew/bin/claude-use");
  });

  it("resolves a relative argv1 against cwd", () => {
    const result = resolveOwnExecutablePath({
      argv1: "./claude-use",
      execPath,
      cwd,
      pathDirs: [],
      findExecutableInDir: () => undefined,
    });
    expect(result).toBe(path.join(cwd, "claude-use"));
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
    const result = resolveOwnExecutablePath({
      argv1: "bin\\claude-use.exe",
      execPath,
      cwd: "C:\\Users\\runner\\work",
      pathDirs: [],
      findExecutableInDir: () => {
        throw new Error("must not search PATH when argv1 already contains a separator");
      },
    });
    expect(result).toBe(path.resolve("C:\\Users\\runner\\work", "bin\\claude-use.exe"));
  });
});

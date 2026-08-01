import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { cosmiconfigReader } from "./config/load";
import { discoverClaudeBinary, type DiscoveredClaudeBinary, type VersionsDirEntry } from "./versionDiscovery";
import type { FarmFs, FsPort, LogPort, ProcPort, RunPort, SpawnPort } from "./launcher/ports";

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** The real, `node:fs`-backed `FsPort` used by the actual `claude` launcher — never used in tests. */
export const realFsPort: FsPort = {
  readFileUtf8(filePath) {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw error;
    }
  },
  readConfigFile: cosmiconfigReader(),
};

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/**
 * The real, `node:fs`-backed `FarmFs` used by an actual resync — never used in tests, which run the whole of `src/launcher/farm.ts` against an in-memory fake.
 *
 * `lstat` never follows symlinks, `copyRecursive` copies a symlink as a symlink rather than as its target's contents, and `writeFileExclusive` uses the `wx` flag so the identity lock's mutual exclusion rests on one atomic syscall rather than a read-then-write pair.
 */
export const realFarmFs: FarmFs = {
  lstat(filePath) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filePath);
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw error;
    }
    const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : "file";
    return { kind, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
  },
  readdir(dirPath) {
    try {
      return fs.readdirSync(dirPath);
    } catch (error) {
      if (isEnoent(error) || isErrorWithCode(error, "ENOTDIR")) {
        return [];
      }
      throw error;
    }
  },
  mkdirp(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
  },
  symlink(target, linkPath) {
    fs.symlinkSync(target, linkPath);
  },
  rename(from, to) {
    fs.renameSync(from, to);
  },
  removeRecursive(targetPath) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  },
  copyRecursive(from, to) {
    fs.cpSync(from, to, { recursive: true, force: true, verbatimSymlinks: true });
  },
  readFileUtf8(filePath) {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw error;
    }
  },
  writeFileUtf8(filePath, contents) {
    fs.writeFileSync(filePath, contents, "utf8");
  },
  writeFileExclusive(filePath, contents) {
    try {
      fs.writeFileSync(filePath, contents, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (error) {
      if (isErrorWithCode(error, "EEXIST")) {
        return false;
      }
      throw error;
    }
  },
  hashFile(filePath) {
    try {
      return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    } catch (error) {
      if (isEnoent(error) || isErrorWithCode(error, "EISDIR")) {
        return undefined;
      }
      throw error;
    }
  },
};

/**
 * Blocks the current thread for `ms` milliseconds.
 *
 * The launcher is synchronous end to end, right through to `spawnSync`, so waiting on another process's identity lock cannot be done with a promise. `Atomics.wait` on a private buffer is the one way to sleep synchronously without burning the CPU in a spin loop.
 */
export function realSleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether a process is still running. Signal 0 performs the permission and existence checks without delivering anything; `EPERM` means the process exists but belongs to another user. */
export function realIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrorWithCode(error, "EPERM");
  }
}

/** The real `RunPort`, used for auxiliary commands whose output this process needs to read — git branch detection for `when: { branch }` conditions, and `check.ts`'s macOS Keychain lookup. */
export const realRunPort: RunPort = {
  run(command, args) {
    const result = spawnSync(command, [...args], { encoding: "utf8" });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  },
};

/** Reads the git branch checked out at `cwd`, and whether the repository is in detached-HEAD state. Both undefined when `cwd` is not in a repository at all. */
export function resolveGitBranch(run: RunPort, cwd: string): { branch?: string; branchDetached?: boolean } {
  const result = run.run("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (result.status !== 0) {
    return {};
  }
  const name = result.stdout.trim();
  if (name === "" ) {
    return {};
  }
  if (name === "HEAD") {
    return { branchDetached: true };
  }
  return { branch: name, branchDetached: false };
}

/** The real `SpawnPort`, backed by `node:child_process`'s `spawnSync` — the Node equivalent of the legacy bash tool's `exec`. */
export const realSpawnPort: SpawnPort = {
  spawnSync(command, args, options) {
    const result = spawnSync(command, args, options);
    return { status: result.status, signal: result.signal, ...(result.error === undefined ? {} : { error: result.error }) };
  },
};

/** The real `ProcPort`, reading the actual process environment and logical CLI argv (`process.argv.slice(2)`). */
export const realProcPort: ProcPort = {
  env: process.env,
  argv: process.argv.slice(2),
  exit: (code: number): never => process.exit(code),
};

/** The real `LogPort`, writing info/warn to stdout and errors to stderr. */
export const realLogPort: LogPort = {
  info: (message: string) => console.log(message),
  warn: (message: string) => console.warn(message),
  error: (message: string) => console.error(message),
};

function listVersionsDir(dir: string): VersionsDirEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const fullPath = path.join(dir, entry.name);
      const stat = fs.statSync(fullPath);
      return {
        name: entry.name,
        isFile: true,
        isExecutable: (stat.mode & 0o111) !== 0,
        sizeBytes: stat.size,
      };
    });
}

/** Looks for a file literally named `name` inside `dir` and confirms it's an executable regular file. Exported so `src/claudeShim.ts`'s PATH-shadow check can reuse the exact same semantics `discoverClaudeBinary`'s own PATH fallback already uses, rather than shelling out to a shell builtin like `command -v`. */
export function findExecutableInDir(dir: string, name: string): string | undefined {
  const candidate = path.join(dir, name);
  try {
    const stat = fs.statSync(candidate);
    if (stat.isFile() && (stat.mode & 0o111) !== 0) {
      return candidate;
    }
    return undefined;
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Resolves the absolute path to the currently-running claude-use/claude executable from the raw process/env facts a call site would otherwise read directly off `process` — passed explicitly so this is unit-testable without touching real process globals.
 *
 * This exists because `process.argv[1]` is not a reliable "path to my own executable" for a Node single-executable-application (SEA) binary the way it is for an ordinary Node script. Per Node's own SEA documentation, a SEA binary's `argv[1]` merely echoes back whatever string appeared on the command line — verbatim, with no path or PATH resolution applied by Node or the OS — whereas a shebang-invoked script (the npm/plain-Node case) genuinely receives its resolved script path there, because the kernel's shebang handling substitutes the shell's already-PATH-resolved pathname before Node ever starts. Concretely: typing the bare word `claude-use` at a shell prompt produces `argv[1] === "claude-use"` for a SEA binary (no directory component at all), which previously got fed straight into `fs.realpathSync`/`path.dirname` as if it were a real path — resolving relative to `process.cwd()` instead of wherever PATH actually found the binary, and throwing ENOENT the moment cwd didn't happen to contain a same-named file. Confirmed via a minimal instrumented SEA binary reproducing exactly this, and matching the exact failure every release verification job hit once invoking `claude-use`/`claude` as a bare PATH-resolved command rather than by absolute path.
 *
 * The fix: if the raw candidate contains a path separator, it's already a real (relative-to-cwd or absolute) path — resolve it against cwd and use it directly, preserving whatever symlink it names (never realpath'd here, since a package manager's PATH-visible entry is often a symlink elsewhere — e.g. Homebrew's `/opt/homebrew/bin/claude-use` -> its own Cellar keg — and callers need that PATH-visible location, not the dereferenced target). If it's a bare word with no separator, it can only have been found via PATH lookup, so search PATH ourselves for the first directory containing an executable of that name, reconstructing exactly what the shell already did.
 */
export function resolveOwnExecutablePath(env: {
  readonly argv1: string | undefined;
  readonly execPath: string;
  readonly cwd: string;
  readonly pathDirs: readonly string[];
  readonly findExecutableInDir: (dir: string, name: string) => string | undefined;
}): string {
  if (env.argv1 === undefined) {
    return env.execPath;
  }
  if (env.argv1.includes("/") || env.argv1.includes("\\")) {
    return path.resolve(env.cwd, env.argv1);
  }
  for (const dir of env.pathDirs) {
    const found = env.findExecutableInDir(dir, env.argv1);
    if (found !== undefined) {
      return found;
    }
  }
  return env.execPath;
}

/** Real-wired convenience over `resolveOwnExecutablePath`, reading the actual process globals — this is what every real call site (`cli.ts`, `doctor.ts`, `claudeShim.ts`'s command wiring) should use instead of reading `process.argv[1]`/`process.execPath` directly. */
export function realOwnExecutablePath(): string {
  return resolveOwnExecutablePath({
    argv1: process.argv[1],
    execPath: process.execPath,
    cwd: process.cwd(),
    pathDirs: (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== ""),
    findExecutableInDir,
  });
}

/** Builds the real `resolveClaudeBinary` callback `runLauncher` needs: scans the real versions directory, then falls back to a real PATH search, excluding this tool's own install directory. */
export function realResolveClaudeBinary(ownInstallDirs: readonly string[]): () => DiscoveredClaudeBinary {
  return () =>
    discoverClaudeBinary({
      listVersionsDir,
      pathDirs: (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== ""),
      findExecutableInDir,
      ownInstallDirs: [...ownInstallDirs],
    });
}

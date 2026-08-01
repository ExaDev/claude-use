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

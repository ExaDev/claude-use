import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { cosmiconfigReader } from "./config/load";
import { discoverClaudeBinary, type DiscoveredClaudeBinary, type VersionsDirEntry } from "./versionDiscovery";
import type { FsPort, LogPort, ProcPort, SpawnPort } from "./launcher/ports";

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
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

function findExecutableInDir(dir: string, name: string): string | undefined {
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

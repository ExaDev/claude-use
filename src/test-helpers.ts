import path from "node:path";

import categoriesDefaultJson from "./config/categories.default.json";
import { CategoryClassificationSchema, type CategoryClassification } from "./config/schema";
import type { FarmFs, FarmStat } from "./launcher/ports";
import type { EntryFact, EntryFacts } from "./resolve";

/** The shipped classification map, parsed once, for use as the default in tests. */
export const shippedClassification: CategoryClassification = CategoryClassificationSchema.parse(categoriesDefaultJson);

/** A fake home directory. Deliberately not the real one: nothing in this project's tests may resolve to a path Joe actually uses. */
export const FAKE_HOME = "/home/testuser";
/** A fake `~/.claude`, matching FAKE_HOME. */
export const FAKE_CLAUDE_HOME = `${FAKE_HOME}/.claude`;

/** How one fake entry should look. Anything omitted gets a deterministic default. */
export interface FakeEntrySpec {
  readonly dir?: boolean;
  readonly symlink?: boolean;
  readonly mtimeMs?: number;
  readonly sizeBytes?: number;
}

/** Fixed "now" for every test, so no assertion is time-dependent. */
export const FAKE_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

/** Milliseconds in one day, for writing readable relative mtimes in fixtures. */
export const DAY_MS = 86_400_000;

/** A fake `sleep(ms)` for lock/retry tests: never actually sleeps, but records every requested delay so a test can assert on backoff behaviour instead of being a bare no-op. */
export function fakeSleep(): { readonly sleep: (ms: number) => void; readonly delays: number[] } {
  const delays: number[] = [];
  return { sleep: (ms: number) => delays.push(ms), delays };
}

function parentOf(rel: string): string {
  const index = rel.lastIndexOf("/");
  return index === -1 ? "" : rel.slice(0, index);
}

/**
 * Builds a fake `EntryFacts` manifest from a flat path-to-spec map.
 *
 * Any parent directory implied by a path but not declared is created automatically, and every directory's `latestMtimeMs` and `totalSizeBytes` are aggregated over its whole subtree — matching what a real fact-builder must do, and what a directory-scoped `newerThan`/`maxSizeBytes` condition depends on.
 */
export function makeFacts(
  specs: Readonly<Record<string, FakeEntrySpec | true>>,
  overrides: Partial<Omit<EntryFacts, "entries">> = {},
): EntryFacts {
  const normalised = new Map<string, FakeEntrySpec>();
  for (const [rel, spec] of Object.entries(specs)) {
    normalised.set(rel, spec === true ? {} : spec);
    let parent = parentOf(rel);
    while (parent !== "") {
      if (!normalised.has(parent)) {
        // An implied parent directory gets a zero mtime and size so it never dominates its own subtree's aggregates — a real directory's own inode stat says nothing about what it contains, and a fixture that accidentally asserted otherwise would hide the very bug the subtree aggregation exists to prevent.
        normalised.set(parent, { dir: true, mtimeMs: 0, sizeBytes: 0 });
      }
      parent = parentOf(parent);
    }
  }

  const children = new Map<string, string[]>();
  for (const rel of normalised.keys()) {
    const parent = parentOf(rel);
    const bucket = children.get(parent);
    if (bucket === undefined) {
      children.set(parent, [rel]);
    } else {
      bucket.push(rel);
    }
  }

  const isDirectory = (rel: string): boolean => normalised.get(rel)?.dir === true || (children.get(rel) ?? []).length > 0;

  const aggregate = (rel: string): { latestMtimeMs: number; totalSizeBytes: number } => {
    const spec = normalised.get(rel) ?? {};
    let latest = spec.mtimeMs ?? FAKE_NOW_MS;
    let total = spec.sizeBytes ?? (isDirectory(rel) ? 0 : 1);
    for (const child of children.get(rel) ?? []) {
      const childAggregate = aggregate(child);
      latest = Math.max(latest, childAggregate.latestMtimeMs);
      total += childAggregate.totalSizeBytes;
    }
    return { latestMtimeMs: latest, totalSizeBytes: total };
  };

  const entries = new Map<string, EntryFact>();
  for (const [rel, spec] of normalised) {
    const directory = isDirectory(rel);
    const { latestMtimeMs, totalSizeBytes } = aggregate(rel);
    entries.set(rel, {
      relPath: rel,
      isDirectory: directory,
      isSymlink: spec.symlink ?? false,
      mtimeMs: spec.mtimeMs ?? FAKE_NOW_MS,
      latestMtimeMs,
      sizeBytes: spec.sizeBytes ?? (directory ? 0 : 1),
      totalSizeBytes,
    });
  }

  return {
    nowMs: FAKE_NOW_MS,
    home: FAKE_HOME,
    claudeHome: FAKE_CLAUDE_HOME,
    cwd: `${FAKE_HOME}/work`,
    env: {},
    ...overrides,
    entries,
  };
}

/** One node of the in-memory filesystem behind `createFakeFarmFs`. */
type FakeNode =
  | { kind: "dir"; mtimeMs: number }
  | { kind: "file"; mtimeMs: number; content: string }
  | { kind: "symlink"; mtimeMs: number; target: string };

/** One mutating operation the fake filesystem performed, recorded so a test can assert that a resync wrote nothing at all. */
interface FakeFsWrite {
  readonly op: "mkdirp" | "symlink" | "rename" | "remove" | "copy" | "write";
  readonly path: string;
}

/** How one seeded entry should look. A string is shorthand for a file with that content. */
export type FakeFsSeed = string | { readonly symlink: string } | { readonly dir: true };

/** An in-memory `FarmFs` plus the extra handles a test needs to seed it and inspect what it did. */
export interface FakeFarmFs extends FarmFs {
  /** Creates entries (and any missing parent directories) from a flat path-to-content map. */
  readonly seed: (entries: Readonly<Record<string, FakeFsSeed>>) => void;
  /** Every mutating operation performed so far, in order. */
  readonly writes: FakeFsWrite[];
  /** Every path currently present, sorted — the whole filesystem, for a snapshot-style assertion. */
  readonly snapshot: (root?: string) => string[];
  /** The symlink target at `path`, or undefined when it is not a symlink. */
  readonly linkTarget: (path: string) => string | undefined;
}

/**
 * Builds an in-memory `FarmFs`.
 *
 * Deliberately stricter than the real thing in the two places where being lenient would hide a bug: writing a file into a directory that does not exist throws rather than creating it, and renaming onto an existing path throws rather than silently replacing it. Both are mistakes the real implementation would surface as an exception too, just later and less legibly.
 */
export function createFakeFarmFs(initial: Readonly<Record<string, FakeFsSeed>> = {}): FakeFarmFs {
  const nodes = new Map<string, FakeNode>();
  const writes: FakeFsWrite[] = [];
  let clock = 1_000;

  const nextMtime = (): number => {
    clock += 1;
    return clock;
  };

  const mkdirp = (dirPath: string): void => {
    const parts = path.resolve(dirPath).split("/").filter((part) => part !== "");
    let current = "";
    for (const part of parts) {
      current = `${current}/${part}`;
      const existing = nodes.get(current);
      if (existing === undefined) {
        nodes.set(current, { kind: "dir", mtimeMs: nextMtime() });
      } else if (existing.kind !== "dir") {
        throw new Error(`Cannot create directory ${dirPath}: ${current} exists and is a ${existing.kind}.`);
      }
    }
  };

  const descendantsOf = (target: string): string[] =>
    [...nodes.keys()].filter((candidate) => candidate.startsWith(`${target}/`));

  const seed = (entries: Readonly<Record<string, FakeFsSeed>>): void => {
    for (const [entryPath, value] of Object.entries(entries)) {
      const resolved = path.resolve(entryPath);
      mkdirp(path.dirname(resolved));
      if (typeof value === "string") {
        nodes.set(resolved, { kind: "file", mtimeMs: nextMtime(), content: value });
      } else if ("symlink" in value) {
        nodes.set(resolved, { kind: "symlink", mtimeMs: nextMtime(), target: value.symlink });
      } else {
        mkdirp(resolved);
      }
    }
  };

  seed(initial);
  writes.length = 0;

  const statOf = (node: FakeNode): FarmStat => {
    if (node.kind === "file") {
      return { kind: "file", mtimeMs: node.mtimeMs, sizeBytes: node.content.length };
    }
    if (node.kind === "symlink") {
      return { kind: "symlink", mtimeMs: node.mtimeMs, sizeBytes: node.target.length };
    }
    return { kind: "dir", mtimeMs: node.mtimeMs, sizeBytes: 0 };
  };

  const fs: FakeFarmFs = {
    seed,
    writes,
    snapshot: (root?: string) =>
      [...nodes.keys()].filter((candidate) => root === undefined || candidate === root || candidate.startsWith(`${root}/`)).sort(),
    linkTarget: (linkPath: string) => {
      const node = nodes.get(path.resolve(linkPath));
      return node?.kind === "symlink" ? node.target : undefined;
    },
    lstat: (target: string) => {
      const node = nodes.get(path.resolve(target));
      return node === undefined ? undefined : statOf(node);
    },
    readdir: (dirPath: string) => {
      const resolved = path.resolve(dirPath);
      if (nodes.get(resolved)?.kind !== "dir") {
        return [];
      }
      const prefix = `${resolved}/`;
      const names = new Set<string>();
      for (const candidate of nodes.keys()) {
        if (!candidate.startsWith(prefix)) {
          continue;
        }
        const rest = candidate.slice(prefix.length);
        const head = rest.split("/")[0];
        if (head !== undefined && head !== "") {
          names.add(head);
        }
      }
      return [...names].sort();
    },
    mkdirp: (dirPath: string) => {
      writes.push({ op: "mkdirp", path: dirPath });
      mkdirp(dirPath);
    },
    symlink: (target: string, linkPath: string) => {
      const resolved = path.resolve(linkPath);
      writes.push({ op: "symlink", path: resolved });
      if (nodes.has(resolved)) {
        throw new Error(`Cannot create symlink ${resolved}: it already exists.`);
      }
      nodes.set(resolved, { kind: "symlink", mtimeMs: nextMtime(), target });
    },
    rename: (from: string, to: string) => {
      const source = path.resolve(from);
      const destination = path.resolve(to);
      writes.push({ op: "rename", path: `${source} -> ${destination}` });
      const node = nodes.get(source);
      if (node === undefined) {
        throw new Error(`Cannot rename ${source}: it does not exist.`);
      }
      if (nodes.has(destination)) {
        throw new Error(`Cannot rename ${source} to ${destination}: the destination already exists.`);
      }
      for (const descendant of descendantsOf(source)) {
        const moved = nodes.get(descendant);
        if (moved !== undefined) {
          nodes.set(`${destination}${descendant.slice(source.length)}`, moved);
          nodes.delete(descendant);
        }
      }
      nodes.set(destination, node);
      nodes.delete(source);
    },
    removeRecursive: (target: string) => {
      const resolved = path.resolve(target);
      writes.push({ op: "remove", path: resolved });
      for (const descendant of descendantsOf(resolved)) {
        nodes.delete(descendant);
      }
      nodes.delete(resolved);
    },
    copyRecursive: (from: string, to: string) => {
      const source = path.resolve(from);
      const destination = path.resolve(to);
      writes.push({ op: "copy", path: `${source} -> ${destination}` });
      const node = nodes.get(source);
      if (node === undefined) {
        throw new Error(`Cannot copy ${source}: it does not exist.`);
      }
      nodes.set(destination, { ...node });
      for (const descendant of descendantsOf(source)) {
        const copied = nodes.get(descendant);
        if (copied !== undefined) {
          nodes.set(`${destination}${descendant.slice(source.length)}`, { ...copied });
        }
      }
    },
    readFileUtf8: (filePath: string) => {
      const node = nodes.get(path.resolve(filePath));
      return node?.kind === "file" ? node.content : undefined;
    },
    writeFileUtf8: (filePath: string, contents: string) => {
      const resolved = path.resolve(filePath);
      writes.push({ op: "write", path: resolved });
      if (nodes.get(path.dirname(resolved))?.kind !== "dir") {
        throw new Error(`Cannot write ${resolved}: its parent directory does not exist.`);
      }
      nodes.set(resolved, { kind: "file", mtimeMs: nextMtime(), content: contents });
    },
    writeFileExclusive: (filePath: string, contents: string) => {
      const resolved = path.resolve(filePath);
      if (nodes.has(resolved)) {
        return false;
      }
      writes.push({ op: "write", path: resolved });
      if (nodes.get(path.dirname(resolved))?.kind !== "dir") {
        throw new Error(`Cannot write ${resolved}: its parent directory does not exist.`);
      }
      nodes.set(resolved, { kind: "file", mtimeMs: nextMtime(), content: contents });
      return true;
    },
    hashFile: (filePath: string) => {
      const node = nodes.get(path.resolve(filePath));
      return node?.kind === "file" ? `sha:${node.content}` : undefined;
    },
  };

  return fs;
}

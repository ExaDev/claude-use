import categoriesDefaultJson from "./config/categories.default.json";
import { CategoryClassificationSchema, type CategoryClassification } from "./config/schema";
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

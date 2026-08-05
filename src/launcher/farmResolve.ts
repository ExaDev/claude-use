import path from "node:path";

import { carryOver } from "./farm";
import type { FarmFs } from "./ports";

/** What to do with one colliding top-level name between a superseded farm and the current one. */
export type FarmConflictChoice = "keep-new" | "keep-old" | "skip";

/** One colliding top-level name, named but not yet decided. */
export interface FarmConflict {
  /** The superseded farm directory this conflict was found in. */
  readonly previousRoot: string;
  /** The live farm directory the conflict is against. */
  readonly farmRoot: string;
  /** The colliding top-level name, relative to both `previousRoot` and `farmRoot`. */
  readonly name: string;
}

/** One conflict, plus what was decided for it. */
interface ResolvedFarmConflict extends FarmConflict {
  readonly choice: FarmConflictChoice;
}

/** Inputs to `resolveFarmConflicts`. */
export interface ResolveFarmConflictsParams {
  readonly fs: FarmFs;
  readonly identitiesDir: string;
  readonly identity: string;
  /** Decides one conflict at a time, called once per colliding name across every retained previous farm, in a stable (sorted) order. */
  readonly decide: (conflict: FarmConflict) => Promise<FarmConflictChoice>;
}

/** What `resolveFarmConflicts` did. */
export interface ResolveFarmConflictsResult {
  /** Every conflict encountered, in the order it was decided, alongside what was chosen for it. */
  readonly resolved: readonly ResolvedFarmConflict[];
  /** Previous-farm directories with every conflict decided (none skipped) and therefore removed. */
  readonly removed: readonly string[];
  /** Previous-farm directories still holding at least one skipped conflict, and therefore still on disk. */
  readonly retained: readonly string[];
}

/**
 * Walks every `.<identity>.previous.*` directory still on disk and, for each top-level name that collides with the current farm, asks `decide` what to do rather than leaving it for a human to resolve by hand outside the tool.
 *
 * Reuses `carryOver`'s own collision detection rather than a second implementation: anything that does *not* collide has already been carried across automatically by an earlier resync, so this only ever has to ask about genuine conflicts — `carryOver`'s own `carried` list is not otherwise interesting here.
 *
 * `keep-new` discards the old copy outright. `keep-old` removes the current farm's own entry at that name and moves the old copy into its place — the same rename `carryOver` already uses for a non-colliding name, just preceded by clearing the spot it collided with. `skip` leaves both copies exactly as they were, and the directory they live in is not removed, so a later run of this same function finds the exact same conflict again rather than silently losing track of it.
 */
export async function resolveFarmConflicts(params: ResolveFarmConflictsParams): Promise<ResolveFarmConflictsResult> {
  const farmRoot = path.join(params.identitiesDir, params.identity);
  const previousPrefix = `.${params.identity}.previous.`;
  const previousRoots = [...params.fs.readdir(params.identitiesDir)]
    .filter((name) => name.startsWith(previousPrefix))
    .sort()
    .map((name) => path.join(params.identitiesDir, name));

  const resolved: ResolvedFarmConflict[] = [];
  const removed: string[] = [];
  const retained: string[] = [];

  for (const previousRoot of previousRoots) {
    const { collided } = carryOver({ fs: params.fs, previousRoot, farmRoot });
    let anySkipped = false;

    for (const name of collided) {
      const choice = await params.decide({ previousRoot, farmRoot, name });
      resolved.push({ previousRoot, farmRoot, name, choice });

      if (choice === "skip") {
        anySkipped = true;
        continue;
      }
      if (choice === "keep-new") {
        params.fs.removeRecursive(path.join(previousRoot, name));
        continue;
      }
      params.fs.removeRecursive(path.join(farmRoot, name));
      params.fs.rename(path.join(previousRoot, name), path.join(farmRoot, name));
    }

    if (anySkipped) {
      retained.push(previousRoot);
    } else {
      params.fs.removeRecursive(previousRoot);
      removed.push(previousRoot);
    }
  }

  return { resolved, removed, retained };
}

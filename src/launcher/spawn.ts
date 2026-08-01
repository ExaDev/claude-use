import os from "node:os";

import type { ProcPort, SpawnPort, SpawnResult } from "./ports";

/** Inputs to `spawnClaude`. */
export interface SpawnClaudeParams {
  /** Full path to the real `claude` binary to run, as discovered by `src/versionDiscovery.ts`. */
  readonly bin: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly spawn: SpawnPort;
  readonly proc: ProcPort;
}

/**
 * Derives the exit code to propagate from a completed `spawnSync` result: the child's own exit status when it exited normally, or the conventional `128 + signal number` when it was terminated by a signal (matching what a real shell's `exec` would report), or `1` as a last resort when the result carries neither.
 */
function exitCodeFor(result: SpawnResult): number {
  if (result.status !== null) {
    return result.status;
  }
  if (result.signal !== null) {
    const signalNumber = os.constants.signals[result.signal] as number | undefined;
    return signalNumber === undefined ? 1 : 128 + signalNumber;
  }
  return 1;
}

/**
 * Runs the real `claude` binary and propagates its exit code faithfully, the Node equivalent of the legacy bash tool's `exec` (process replacement): `spawnSync(bin, args, { stdio: "inherit" })` followed by `process.exit(status)`.
 *
 * Throws when the child could not even be spawned (e.g. `bin` does not exist) rather than silently exiting — a spawn failure is a real problem, not a clean exit code to propagate.
 */
export function spawnClaude(params: SpawnClaudeParams): never {
  const result = params.spawn.spawnSync(params.bin, params.args, { stdio: "inherit", env: params.env });
  if (result.error !== undefined) {
    throw result.error;
  }
  return params.proc.exit(exitCodeFor(result));
}

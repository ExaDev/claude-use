import type { ConfigFileReader } from "../config/load";

/**
 * Filesystem operations the launcher needs, injected so no test in this project ever touches a real filesystem — consistent with the resolver core's own injected-facts approach in `src/resolve/types.ts`.
 */
export interface FsPort {
  /** Reads a file's contents as UTF-8 text, or returns undefined when it does not exist. Used for plain-text files like the persisted active-identity file. */
  readonly readFileUtf8: (filePath: string) => string | undefined;
  /** Reads and parses a config file (JSON/YAML/JS via cosmiconfig in the real implementation), returning undefined when it does not exist. Mirrors `src/config/load.ts`'s own injected reader shape so `loadIdentity` can compose directly with `loadConfigFile`. */
  readonly readConfigFile: ConfigFileReader;
}

/** The outcome of one `spawnSync` call, mirroring Node's own `SpawnSyncReturns` shape narrowly to what the launcher actually reads. */
export interface SpawnResult {
  /** The child's exit code, or null when it was terminated by a signal instead of exiting normally. */
  readonly status: number | null;
  /** The signal that terminated the child, or null when it exited normally. */
  readonly signal: NodeJS.Signals | null;
  /** Set when the child process could not even be spawned (e.g. the binary does not exist). */
  readonly error?: Error;
}

/** Runs the real `claude` binary synchronously, injected so no test ever spawns a real process. The Node equivalent of the legacy bash tool's `exec` is `spawnSync` with `stdio: "inherit"` followed by propagating the child's own exit code — see `src/launcher/spawn.ts`. */
export interface SpawnPort {
  readonly spawnSync: (
    command: string,
    args: readonly string[],
    options: { readonly stdio: "inherit"; readonly env: Readonly<Record<string, string | undefined>> },
  ) => SpawnResult;
}

/** The outcome of one synchronous external-command run (distinct from `SpawnPort`, which is specifically for replacing this process with the real `claude` binary — `RunPort` is for auxiliary commands like `git rev-parse` for branch detection, or `security find-generic-password` for the macOS Keychain diagnostic in `check.ts`, whose output this process needs to keep running and read). */
export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs an external command and captures its output, injected so no test ever shells out for real. Not used by this phase's own modules yet — declared here so every later module (branch-conditioned `when` evaluation, `check.ts`'s Keychain lookup) shares one injectable shape rather than each inventing its own. */
export interface RunPort {
  readonly run: (command: string, args: readonly string[]) => RunResult;
}

/** The current time, injected so no test result depends on when it happened to run. */
export interface ClockPort {
  readonly nowMs: () => number;
}

/**
 * The running process itself: its environment, its logical argv, and the ability to terminate with an exit code.
 *
 * `argv` is the *logical* CLI arguments only — whatever the user typed after `claude`/`claude-use`, already stripped of the Node executable path and the script path (`process.argv.slice(2)` in the real implementation). `exit` mirrors `process.exit`'s own `never` return type: a real process never returns from it, and a test fake enforces the same shape by throwing a marker so control flow unwinds the same way in both cases.
 */
export interface ProcPort {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly exit: (code: number) => never;
}

/** Where the launcher reports what it decided and why — refusals, warnings about an identity that could not be loaded, and (per the "strictly-better than the legacy script" goal) which identity/profile ended up selected. */
export interface LogPort {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
}

/** The result of splitting a leading `@name` identity token off the launcher's own argv, if one was present. */
export interface ParsedLauncherArgv {
  /** The identity name from a leading `@name` positional, when one was present at argv[0]. */
  readonly identity?: string;
  /** Everything else, unchanged and in order — including any `@`-prefixed token that appears anywhere other than argv[0], which is never treated specially. */
  readonly rest: readonly string[];
}

/**
 * Parses the launcher's own argv for a leading `@name` identity selector.
 *
 * The `@name` form is consumed ONLY at argv[0] — never mid-argument-list — and is stripped from what gets forwarded to the real Claude Code binary. A bare `@` with nothing after it is not a valid identity token and is left in place as an ordinary passthrough argument, since there is no name to extract.
 */
export function parseLauncherArgv(argv: readonly string[]): ParsedLauncherArgv {
  const first = argv[0];
  if (first !== undefined && first.startsWith("@") && first.length > 1) {
    return { identity: first.slice(1), rest: argv.slice(1) };
  }
  return { rest: argv };
}

/**
 * Base class for every error this CLI throws to represent an expected, user-facing failure — bad input, a missing identity/profile/rule, a malformed config file. `main()` in `src/cli.ts` catches this class specifically and prints just `error.message`, with no stack trace; anything that does not extend it still crashes with its full stack trace, since that represents a genuine, unexpected bug worth seeing in full.
 */
export abstract class CliError extends Error {}

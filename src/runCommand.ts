import type { Command } from "commander";

/**
 * Registers `claude-use run [args...]`, forwarding every argument to `handler` exactly as typed. Kept in its own module, separate from `cli.ts`'s `buildClaudeUseProgram`, so its Commander parsing behaviour -- in particular, preserving a literal `--` inside the forwarded args rather than losing it -- is testable without importing `cli.ts` itself, which runs the real CLI as a top-level side effect on import.
 */
export function registerRunCommand(program: Command, handler: (args: readonly string[]) => Promise<void>): void {
  program
    .command("run")
    .description(
      "Run the launcher pipeline directly, without needing a `claude`-named binary on PATH. " +
        "Every argument is forwarded exactly as `claude` would receive it.",
    )
    .allowUnknownOption()
    // Without this, Commander treats a literal `--` inside the forwarded args as its own end-of-options marker and strips it before it reaches `args`, so a downstream flag meant to be shielded from parsing (e.g. `claude mcp add name -- npx -y pkg`) arrives at the real `claude` binary with no `--` at all, and its own Commander parser then rejects the bare `-y` as an unknown option of its own. `passThroughOptions` makes Commander forward every token after the first one verbatim, `--` included. It requires the parent program to have already called `enablePositionalOptions()`, which `buildClaudeUseProgram` does.
    .passThroughOptions()
    .helpOption(false)
    .argument("[args...]", "Arguments to forward, e.g. @<name>, --config-profile <name>, or any Claude Code flag.")
    .action(async (args: readonly string[]) => {
      await handler(args);
    });
}

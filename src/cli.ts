import path from "node:path";
import { Command } from "commander";

import { registerIdentityCommand } from "./identityManager";
import { registerProfileCommand } from "./configProfiles";
import { registerRulesCommand } from "./directoryRules";
import { resolveLayoutPaths } from "./paths";
import { runLauncher } from "./launcher";
import { realFsPort, realLogPort, realProcPort, realResolveClaudeBinary, realSpawnPort } from "./realPorts";

/**
 * The single entrypoint backing both the `claude` and `claude-use` binaries — one compiled artifact, dispatching on which name it was invoked as (`path.basename(process.argv[1])`), per the SEA packaging proof-of-concept validated in Phase 2.
 *
 * `claude` runs the launcher (`src/launcher.ts`'s `runLauncher`), wired here with real ports (`src/realPorts.ts`) instead of the fakes every test in this project uses. This phase wires identity resolution and launch-flag env-var escape hatches end to end — `claude @name` and `CLAUDE_ACCOUNT=name claude` already work against an identity created with `claude-use identity add`, spawning the real `claude` binary with `CLAUDE_CONFIG_DIR` pointed straight at that identity's own directory. There is no symlink farm yet: cascade resolution and farm resync are Phase 5's job, and `runLauncher` is already structured to slot that in without changing anything here.
 *
 * `claude-use` runs the Commander tree exposing `identity`/`profile`/`rules` subcommands, each a thin adapter over `src/config/store.ts` and the Zod schemas in `src/config/schema.ts`.
 */
function buildClaudeUseProgram(): Command {
  const program = new Command();
  program.name("claude-use").description("Profile manager for Claude Code identities and configuration profiles.");

  const paths = resolveLayoutPaths();
  registerIdentityCommand(program, paths);
  registerProfileCommand(program, paths);
  registerRulesCommand(program, paths);

  return program;
}

function runClaude(): void {
  const paths = resolveLayoutPaths();
  runLauncher({
    paths,
    fs: realFsPort,
    spawn: realSpawnPort,
    proc: realProcPort,
    log: realLogPort,
    resolveClaudeBinary: realResolveClaudeBinary([path.dirname(process.argv[1] ?? process.execPath)]),
  });
}

function main(): void {
  const invokedName = path.basename(process.argv[1] ?? "claude-use");
  if (invokedName === "claude") {
    runClaude();
  } else {
    buildClaudeUseProgram().parse(process.argv);
  }
}

main();

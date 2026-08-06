import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Command } from "commander";

import categoriesDefaultJson from "./config/categories.default.json";
import packageJson from "../package.json";
import { cosmiconfigReader } from "./config/load";
import { CategoryClassificationOverlaySchema, CategoryClassificationSchema } from "./config/schema";
import { readJson } from "./config/store";
import { registerCheckCommand } from "./check";
import { CliError } from "./cliError";
import { registerConfigureCommand } from "./configure";
import { isInvokedAsClaude, registerShimCommand, resolveOwnInstallDirs } from "./claudeShim";
import { registerDoctorCommand } from "./doctor";
import { registerIdentityCommand, tryRunAtIdentityShortcut } from "./identityManager";
import { registerProfileCommand } from "./configProfiles";
import { registerRulesCommand } from "./directoryRules";
import { resolveClaudeHome, resolveLayoutPaths, type LayoutPaths } from "./paths";
import { runLauncher, type FarmRuntime } from "./launcher";
import { loadCascadeInput, readDirectorySelections } from "./launcher/cascade";
import {
  realFarmFs,
  realFsPort,
  realIsProcessAlive,
  realLogPort,
  realOwnExecutablePath,
  realProcPort,
  realResolveClaudeBinary,
  realRunPort,
  realSleepSync,
  realSpawnPort,
  resolveGitBranch,
} from "./realPorts";

/**
 * The single entrypoint backing both the `claude` and `claude-use` binaries — one compiled artifact, dispatching on which name it was invoked as (`path.basename(process.argv[1])`), per the SEA packaging proof-of-concept validated in Phase 2.
 *
 * `claude` runs the launcher (`src/launcher.ts`'s `runLauncher`), wired here with real ports (`src/realPorts.ts`) instead of the fakes every test in this project uses. It resolves the identity, loads and assembles the cascade for the current directory, resyncs that identity's symlink farm to match, and spawns the real `claude` binary with `CLAUDE_CONFIG_DIR` pointed at the farm.
 *
 * `claude-use` runs the Commander tree exposing `identity`/`profile`/`rules`/`check`/`configure`/`doctor`/`shim` subcommands, each a thin adapter over `src/config/store.ts` and the Zod schemas in `src/config/schema.ts` — plus `run`, which reaches the exact same launcher pipeline as the `claude` binary above, just fed a different argv source, so a `claude`-named file on `PATH` is never required. `shim enable`/`shim disable` is the one explicit, separate action that creates or removes that `claude`-named file at all — nothing does so automatically.
 */
function buildClaudeUseProgram(): Command {
  const program = new Command();
  program
    .name("claude-use")
    .description("Profile manager for Claude Code identities and configuration profiles.")
    .version(packageJson.version)
    // Required so `-V`/`--version`/`-h`/`--help` are only recognised before the first subcommand token, not scanned for anywhere in argv -- otherwise `claude-use run @name --version` would be silently intercepted by claude-use's own version handling before ever reaching `run`'s forwarded args.
    .enablePositionalOptions();

  const paths = resolveLayoutPaths();
  registerIdentityCommand(program, paths);
  registerProfileCommand(program, paths);
  registerRulesCommand(program, paths);
  registerCheckCommand(program, paths);
  registerConfigureCommand(program, paths);
  registerDoctorCommand(program, paths);
  registerShimCommand(program, paths);

  program
    .command("run")
    .description(
      "Run the launcher pipeline directly, without needing a `claude`-named binary on PATH. " +
        "Every argument is forwarded exactly as `claude` would receive it.",
    )
    .allowUnknownOption()
    .helpOption(false)
    .argument("[args...]", "Arguments to forward, e.g. @<name>, --config-profile <name>, or any Claude Code flag.")
    .action((args: string[]) => {
      runClaude(args);
    });

  return program;
}

/** Builds the farm runtime the launcher's resync step needs, wired to real filesystem, clock, git, and process facilities, plus the directory-scoped selections the launcher needs before it can resync anything. */
function buildFarmRuntime(paths: LayoutPaths): {
  runtime: FarmRuntime;
  directoryIdentity?: string;
  directoryConfigProfile?: string;
  globalDefaultConfigProfile?: string;
} {
  const home = os.homedir();
  const cwd = process.cwd();
  const read = cosmiconfigReader();
  const overlay = readJson(paths.categoriesLocalFile, CategoryClassificationOverlaySchema);
  const classification = {
    defaults: CategoryClassificationSchema.parse(categoriesDefaultJson),
    ...(overlay === undefined ? {} : { overlay }),
  };
  const loaded = loadCascadeInput({ paths, home, cwd, read });
  const selections = readDirectorySelections(loaded);
  const git = resolveGitBranch(realRunPort, cwd);

  return {
    runtime: {
      fs: realFarmFs,
      claudeHome: resolveClaudeHome(),
      home,
      cwd,
      ...(git.branch === undefined ? {} : { branch: git.branch }),
      ...(git.branchDetached === undefined ? {} : { branchDetached: git.branchDetached }),
      classification,
      loadCascade: (baseConfigProfile, cliOverride) =>
        loadCascadeInput({
          paths,
          home,
          cwd,
          read,
          ...(baseConfigProfile === undefined ? {} : { baseConfigProfile }),
          ...(cliOverride === undefined ? {} : { cliOverride }),
        }).input,
      now: () => Date.now(),
      uniqueSuffix: `${process.pid}.${randomUUID()}`,
      lock: { pid: process.pid, isProcessAlive: realIsProcessAlive, sleep: realSleepSync },
    },
    ...(selections.identity === undefined ? {} : { directoryIdentity: selections.identity }),
    ...(selections.configProfile === undefined ? {} : { directoryConfigProfile: selections.configProfile }),
    ...(loaded.globalConfig?.defaultConfigProfile === undefined
      ? {}
      : { globalDefaultConfigProfile: loaded.globalConfig.defaultConfigProfile }),
  };
}

/** Runs the launcher pipeline. `argvOverride`, when given, replaces `realProcPort`'s own `process.argv.slice(2)` -- this is what lets `claude-use run [args...]` reach the identical pipeline the `claude` binary name uses, fed the args Commander collected instead of the real argv. */
function runClaude(argvOverride?: readonly string[]): void {
  const paths = resolveLayoutPaths();
  const farm = buildFarmRuntime(paths);
  runLauncher({
    paths,
    fs: realFsPort,
    spawn: realSpawnPort,
    proc: argvOverride === undefined ? realProcPort : { ...realProcPort, argv: argvOverride },
    log: realLogPort,
    resolveClaudeBinary: realResolveClaudeBinary(resolveOwnInstallDirs(paths, realOwnExecutablePath())),
    farm: farm.runtime,
    ...(farm.directoryIdentity === undefined ? {} : { directoryPinnedIdentity: farm.directoryIdentity }),
    ...(farm.directoryConfigProfile === undefined ? {} : { directoryRuleConfigProfile: farm.directoryConfigProfile }),
    ...(farm.globalDefaultConfigProfile === undefined ? {} : { globalDefaultConfigProfile: farm.globalDefaultConfigProfile }),
  });
}

/**
 * `parseAsync`, not `parse` -- some Commander actions (e.g. `identity resolve <name>`) are `async` and return a promise Commander never awaits under `parse`, so a rejection there would surface as an unhandled promise rejection rather than reaching the catch below.
 */
async function main(): Promise<void> {
  const invokedName = path.basename(process.argv[1] ?? "claude-use");
  if (isInvokedAsClaude(invokedName)) {
    runClaude();
    return;
  }
  if (tryRunAtIdentityShortcut(resolveLayoutPaths(), process.argv.slice(2))) {
    return;
  }
  await buildClaudeUseProgram().parseAsync(process.argv);
}

main().catch((error: unknown) => {
  // A CliError represents an expected, user-facing failure -- bad input, a missing identity/profile/rule -- so it prints as a clean one-line message. Anything else is a genuine bug and is rethrown to crash with its full stack trace, which is more useful for diagnosing it than swallowing it would be.
  if (error instanceof CliError) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  throw error;
});

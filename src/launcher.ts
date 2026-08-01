import type { LayoutPaths } from "./paths";
import { parseLauncherArgv } from "./launcher/argv";
import { evaluateAmbientCredentialGuard } from "./launcher/guard";
import { decideConfigProfile, decideIdentity, loadIdentity } from "./launcher/identity";
import { buildArgv, buildEnv, buildFlagArgs, resolveLaunchFlags } from "./launcher/flags";
import { splitExtraFlags } from "./launcher/extraFlags";
import type { FsPort, LogPort, ProcPort, SpawnPort } from "./launcher/ports";
import { spawnClaude } from "./launcher/spawn";
import type { DiscoveredClaudeBinary } from "./versionDiscovery";

/** Inputs to `runLauncher`. */
export interface RunLauncherParams {
  readonly paths: LayoutPaths;
  readonly fs: FsPort;
  readonly spawn: SpawnPort;
  readonly proc: ProcPort;
  readonly log: LogPort;
  /** Discovers the real `claude` binary to spawn. Injected so `runLauncher` never depends on `src/versionDiscovery.ts`'s own filesystem/PATH inputs directly — the caller (`src/cli.ts`) wires the real discovery, tests wire a fake that returns a fixed path. */
  readonly resolveClaudeBinary: () => DiscoveredClaudeBinary;
  /** An identity pinned to `$PWD` by a directory rule. Accepted as an already-resolved value — the rules-loading code that produces it lands in Phase 4/5. */
  readonly directoryPinnedIdentity?: string;
  /** A directory rule's `configProfile` selection for `$PWD`. Accepted as an already-resolved value for the same reason. */
  readonly directoryRuleConfigProfile?: string;
  /** An explicit `--config-profile` CLI flag, when the caller's own argument parsing found one. */
  readonly cliFlagConfigProfile?: string;
  /** The user-global `~/.claude-use/config.json` default configuration profile, when one is configured. */
  readonly globalDefaultConfigProfile?: string;
}

/**
 * Orchestrates one `claude` launch, in order:
 *
 * `CLAUDE_CONFIG_DIR` escape-hatch check -> ambient-credential guard -> identity/config-profile decision -> version discovery -> flag resolution -> extra-flags split -> spawn.
 *
 * Cascade resolution and farm resync are Phase 5's job — this phase resolves launch flags directly from whatever the loaded identity carries (nothing yet, since config profiles themselves aren't loaded until Phase 4), plus the one-off environment variable escape hatches, which is exactly what `resolveLaunchFlags` already treats an absent cascade value as equivalent to. Phase 5 slots cascade assembly and farm resync in between the config-profile decision and flag resolution without needing to restructure anything here — every step below is already its own discrete, sequential call.
 */
export function runLauncher(params: RunLauncherParams): void {
  const { paths, fs, spawn, proc, log } = params;
  const { env, argv } = proc;

  const parsedArgv = parseLauncherArgv(argv);
  const configDirEscapeHatchApplies = env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== "";

  const identityDecision = decideIdentity({
    env,
    argv0Identity: parsedArgv.identity,
    directoryPinnedIdentity: params.directoryPinnedIdentity,
    readActiveIdentityFile: () => {
      const raw = fs.readFileUtf8(paths.activeIdentityFile);
      if (raw === undefined) {
        return undefined;
      }
      const trimmed = raw.trim();
      return trimmed === "" ? undefined : trimmed;
    },
  });

  let loadedIdentity: ReturnType<typeof loadIdentity>;
  if (identityDecision.name !== undefined) {
    loadedIdentity = loadIdentity(paths.identitiesDir, identityDecision.name, fs);
    if (loadedIdentity === undefined) {
      log.warn(
        `claude-use: identity '${identityDecision.name}' (resolved via ${identityDecision.source}) has no ` +
          `identity.json yet under ${paths.identitiesDir} — proceeding without its settings. Run ` +
          "`claude-use identity add` to create it.",
      );
    }
  }

  const guardResult = evaluateAmbientCredentialGuard({
    env,
    allowAmbientCredential: loadedIdentity?.config.allowAmbientCredential ?? false,
    allowAmbientCredentialOverride: env.CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL === "1",
    identityName: identityDecision.name,
  });
  if (!guardResult.ok) {
    log.error(guardResult.message);
    return proc.exit(1);
  }

  const configProfileDecision = decideConfigProfile({
    env,
    cliFlagConfigProfile: params.cliFlagConfigProfile,
    directoryRuleConfigProfile: params.directoryRuleConfigProfile,
    identityDefaultConfigProfile: loadedIdentity?.config.defaultConfigProfile,
    globalDefaultConfigProfile: params.globalDefaultConfigProfile,
  });

  log.info(
    `claude-use: identity ${identityDecision.name ?? "(none)"} (${identityDecision.source}), ` +
      `config profile ${configProfileDecision.name ?? "(none)"} (${configProfileDecision.source})`,
  );

  // Phase 5 slots cascade assembly + farm resync here, between the config-profile decision above and flag resolution below — nothing above or below this comment needs to change to make room for it.

  const discovered = params.resolveClaudeBinary();

  const resolvedFlags = resolveLaunchFlags({ env });
  const finalArgv = buildArgv({
    toolFlags: buildFlagArgs(resolvedFlags),
    extraFlags: splitExtraFlags(env.CLAUDE_EXTRA_FLAGS),
    passthrough: parsedArgv.rest,
  });
  const finalEnv = buildEnv({
    baseEnv: env,
    configDirEscapeHatch: configDirEscapeHatchApplies,
    resolvedIdentityName: identityDecision.name,
    identitiesDir: paths.identitiesDir,
  });

  spawnClaude({ bin: discovered.path, args: finalArgv, env: finalEnv, spawn, proc });
}

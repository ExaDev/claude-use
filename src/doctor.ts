import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { z } from "zod";

import { lookupKeychainService } from "./check";
import { ClaudeShimStateSchema, resolveOwnInstallDirs, type ClaudeShimState } from "./claudeShim";
import { ConfigValidationError } from "./config/load";
import { readJson } from "./config/store";
import {
  CategoryClassificationOverlaySchema,
  ConfigProfileSchema,
  DirectoryRulesSchema,
  GlobalConfigSchema,
  IdentitySchema,
} from "./config/schema";
import { detectAmbientCredential, formatAmbientCredentialGuardMessage } from "./launcher/guard";
import type { RunPort } from "./launcher/ports";
import type { LayoutPaths } from "./paths";
import { realFsPort, realOwnExecutablePath, realResolveClaudeBinary, realRunPort } from "./realPorts";
import { lineariseProfile, type ProfileLoader, type ProfileSource } from "./resolve";
import type { DiscoveredClaudeBinary } from "./versionDiscovery";

export type DoctorSeverity = "pass" | "warn" | "fail";

export type DoctorSection =
  | "ambient-credential"
  | "binary-discovery"
  | "claude-shim"
  | "config-profile"
  | "identity"
  | "keychain"
  | "directory-rules"
  | "global-config"
  | "categories-local"
  | "active-identity";

/** One line of `claude-use doctor`'s report. `subject` names the identity/profile/rule the finding is about, when the section has more than one of those. */
export interface DoctorFinding {
  readonly section: DoctorSection;
  readonly subject?: string;
  readonly severity: DoctorSeverity;
  readonly message: string;
}

/** The full result of `runDoctor`. `ok` is false iff any finding is a `fail` — a `warn` never fails the report on its own. */
export interface DoctorReport {
  readonly findings: readonly DoctorFinding[];
  readonly ok: boolean;
}

/** One identity's raw `identity.json`, unparsed — `runDoctor` does its own JSON.parse/schema validation so one malformed file never aborts the rest of the report. */
export interface DoctorIdentityInput {
  readonly name: string;
  readonly path: string;
  readonly raw: string | undefined;
  /** The identity's own farm root (`identitiesDir/<name>`) — the account name the Keychain lookup uses. */
  readonly farmRoot: string;
}

/** One configuration profile's raw `<name>.json`, unparsed. */
export interface DoctorConfigProfileInput {
  readonly name: string;
  readonly path: string;
  readonly raw: string | undefined;
}

/** A single optional top-level file `runDoctor` validates against a schema when present — absent is a legitimate, unconfigured state, not a failure. */
interface DoctorFileInput {
  readonly path: string;
  readonly raw: string | undefined;
}

/** The outcome of resolving the real Claude Code binary, pre-resolved by the wiring layer since `discoverClaudeBinary` is not itself a parse-shaped pure operation and already has its own dedicated test coverage. */
export type DoctorBinaryDiscovery =
  | { readonly ok: true; readonly binary: DiscoveredClaudeBinary }
  | { readonly ok: false; readonly message: string };

/** Everything `runDoctor` needs, all of it already loaded/injected — nothing in `runDoctor` itself reads a file, shells out, or touches the farm. */
export interface RunDoctorParams {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly identities: readonly DoctorIdentityInput[];
  readonly configProfiles: readonly DoctorConfigProfileInput[];
  readonly directoryRules: DoctorFileInput;
  readonly globalConfig: DoctorFileInput;
  readonly categoriesLocal: DoctorFileInput;
  readonly activeIdentity: DoctorFileInput;
  readonly binaryDiscovery: DoctorBinaryDiscovery;
  /** Whether `claude-use shim enable` has been run, and whether its recorded target still exists on disk — pre-resolved by the wiring layer, since checking a file's existence is real I/O, not a parse-shaped pure operation. */
  readonly claudeShim: { readonly state: ClaudeShimState | undefined; readonly targetExists: boolean };
  /** Runs `security find-generic-password` for the per-identity Keychain check. Omit to skip that check entirely (e.g. off macOS). */
  readonly run?: RunPort;
  /** `process.platform` in real use; the Keychain check only ever runs when this is `"darwin"`. */
  readonly platform: string;
}

/** Parses and validates one optional JSON file's raw text against `schema`, without ever throwing — a missing file, invalid JSON, and a schema violation are each reported as their own failure message rather than aborting the caller. */
function validateJson<S extends z.ZodType>(
  schema: S,
  input: DoctorFileInput,
): { readonly ok: true; readonly data: z.infer<S> } | { readonly ok: false; readonly message: string } {
  if (input.raw === undefined) {
    return { ok: false, message: `${input.path} is missing.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch (error) {
    return { ok: false, message: `${input.path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, message: new ConfigValidationError(input.path, result.error.issues).message };
  }
  return { ok: true, data: result.data };
}

/**
 * Audits the whole `~/.claude-use` config graph for internal consistency: every identity, every configuration profile's own `extends` chain, `directory-rules.json`, `config.json`, `categories.local.json`, `active-identity`, plus real Claude Code binary discoverability and ambient-credential exposure.
 *
 * Deliberately identity/directory-agnostic, unlike `runCheck` — there is no single cascade to resolve `doctor` against, so it never touches settings-exposure (which only means anything relative to one resolved cascade).
 *
 * Every check aggregates rather than throws: a malformed file becomes one `fail` finding for that file, not an aborted report. This is the one place in the codebase that deliberately breaks the "throw a validation error and let it propagate" convention every other command relies on — `doctor`'s whole purpose is to survive a broken file and keep auditing everything else.
 */
export function runDoctor(params: RunDoctorParams): DoctorReport {
  const findings: DoctorFinding[] = [];
  const push = (section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string): void => {
    findings.push({ section, severity, message, ...(subject === undefined ? {} : { subject }) });
  };

  const ambient = detectAmbientCredential(params.env);
  if (ambient === undefined) {
    push("ambient-credential", "pass", "No ambient-credential environment variable is set.");
  } else {
    push("ambient-credential", "warn", formatAmbientCredentialGuardMessage(ambient.variable));
  }

  if (params.binaryDiscovery.ok) {
    const { binary } = params.binaryDiscovery;
    const versionNote = binary.version === undefined ? "" : `, version ${binary.version}`;
    push("binary-discovery", "pass", `Found ${binary.path} (${binary.source}${versionNote}).`);
  } else {
    push("binary-discovery", "fail", params.binaryDiscovery.message);
  }

  if (params.claudeShim.state === undefined) {
    push("claude-shim", "pass", "No `claude` command shim enabled (the default). Run `claude-use shim enable` to add one.");
  } else if (!params.claudeShim.targetExists) {
    push(
      "claude-shim",
      "warn",
      `claude-shim.json records a \`claude\` shim at ${params.claudeShim.state.targetPath}, but nothing is there. ` +
        "Run `claude-use shim enable` again, or `claude-use shim disable` to clear the stale record.",
    );
  } else {
    push(
      "claude-shim",
      "pass",
      `\`claude\` is enabled at ${params.claudeShim.state.targetPath} (${params.claudeShim.state.method}). ` +
        "If you've upgraded claude-use since, re-run `claude-use shim enable` to refresh it.",
    );
  }

  const profileSources = new Map<string, ProfileSource>();
  for (const entry of params.configProfiles) {
    const validated = validateJson(ConfigProfileSchema, entry);
    if (!validated.ok) {
      push("config-profile", "fail", validated.message, entry.name);
      continue;
    }
    profileSources.set(entry.name, { name: entry.name, profile: validated.data });
  }
  const loadProfile: ProfileLoader = (name) => profileSources.get(name);
  for (const name of profileSources.keys()) {
    const linearised = lineariseProfile(name, loadProfile);
    if (linearised.diagnostics.length === 0) {
      push("config-profile", "pass", `${name} is valid and its extends chain resolves cleanly.`, name);
    } else {
      for (const diagnostic of linearised.diagnostics) {
        push("config-profile", "fail", diagnostic.message, name);
      }
    }
  }
  const validProfileNames = new Set(profileSources.keys());

  const validIdentityNames = new Set<string>();
  for (const entry of params.identities) {
    const validated = validateJson(IdentitySchema, entry);
    if (!validated.ok) {
      push("identity", "fail", validated.message, entry.name);
      continue;
    }
    validIdentityNames.add(entry.name);
    const defaultProfile = validated.data.defaultConfigProfile;
    if (defaultProfile !== undefined && !validProfileNames.has(defaultProfile)) {
      push(
        "identity",
        "fail",
        `Identity "${entry.name}" names configuration profile "${defaultProfile}" as its default, but no such profile exists.`,
        entry.name,
      );
    } else {
      push("identity", "pass", `${entry.name} is valid.`, entry.name);
    }
  }

  if (params.platform !== "darwin" || params.run === undefined) {
    push("keychain", "pass", "Skipped (not macOS).");
  } else {
    for (const entry of params.identities) {
      const result = lookupKeychainService(params.run, entry.farmRoot);
      push("keychain", result.found ? "pass" : "warn", result.note, entry.name);
    }
  }

  if (params.directoryRules.raw === undefined) {
    push("directory-rules", "pass", "No directory-rules.json configured.");
  } else {
    const validated = validateJson(DirectoryRulesSchema, params.directoryRules);
    if (!validated.ok) {
      push("directory-rules", "fail", validated.message);
    } else {
      push("directory-rules", "pass", `${params.directoryRules.path} is valid.`);
      for (const rule of validated.data.rules) {
        const badRefs: string[] = [];
        if (rule.identity !== undefined && !validIdentityNames.has(rule.identity)) {
          badRefs.push(`identity "${rule.identity}"`);
        }
        if (rule.configProfile !== undefined && !validProfileNames.has(rule.configProfile)) {
          badRefs.push(`configuration profile "${rule.configProfile}"`);
        }
        if (badRefs.length > 0) {
          push("directory-rules", "fail", `Rule for "${rule.path}" names ${badRefs.join(" and ")}, which do not exist.`, rule.path);
        } else {
          push("directory-rules", "pass", `Rule for "${rule.path}" is valid.`, rule.path);
        }
      }
    }
  }

  if (params.globalConfig.raw === undefined) {
    push("global-config", "pass", "No config.json configured.");
  } else {
    const validated = validateJson(GlobalConfigSchema, params.globalConfig);
    if (!validated.ok) {
      push("global-config", "fail", validated.message);
    } else {
      const defaultProfile = validated.data.defaultConfigProfile;
      if (defaultProfile !== undefined && !validProfileNames.has(defaultProfile)) {
        push(
          "global-config",
          "fail",
          `config.json names configuration profile "${defaultProfile}" as its default, but no such profile exists.`,
        );
      } else {
        push("global-config", "pass", `${params.globalConfig.path} is valid.`);
      }
    }
  }

  if (params.categoriesLocal.raw === undefined) {
    push("categories-local", "pass", "No categories.local.json configured.");
  } else {
    const validated = validateJson(CategoryClassificationOverlaySchema, params.categoriesLocal);
    push(
      "categories-local",
      validated.ok ? "pass" : "fail",
      validated.ok ? `${params.categoriesLocal.path} is valid.` : validated.message,
    );
  }

  if (params.activeIdentity.raw === undefined) {
    push("active-identity", "pass", "No active identity set.");
  } else {
    const trimmed = params.activeIdentity.raw.trim();
    if (trimmed === "") {
      push("active-identity", "warn", "active-identity is present but empty — treated the same as unset.");
    } else if (!validIdentityNames.has(trimmed)) {
      push("active-identity", "fail", `active-identity names "${trimmed}", which does not exist.`);
    } else {
      push("active-identity", "pass", `Active identity "${trimmed}" is valid.`);
    }
  }

  return { findings, ok: !findings.some((finding) => finding.severity === "fail") };
}

const SECTION_TITLES: Readonly<Record<DoctorSection, string>> = {
  "ambient-credential": "Ambient-credential exposure",
  "binary-discovery": "Claude Code binary discovery",
  "claude-shim": "`claude` command shim",
  "config-profile": "Configuration profiles",
  identity: "Identities",
  keychain: "macOS Keychain",
  "directory-rules": "Directory rules",
  "global-config": "Global config",
  "categories-local": "categories.local.json",
  "active-identity": "Active identity",
};

const SECTION_ORDER: readonly DoctorSection[] = [
  "ambient-credential",
  "binary-discovery",
  "claude-shim",
  "config-profile",
  "identity",
  "keychain",
  "directory-rules",
  "global-config",
  "categories-local",
  "active-identity",
];

function severityPrefix(severity: DoctorSeverity): string {
  switch (severity) {
    case "pass":
      return "[PASS]";
    case "warn":
      return "[WARN]";
    case "fail":
      return "[FAIL]";
  }
}

/** Renders a full `DoctorReport` as plain text lines, one section header at a time, in the order `claude-use doctor` prints them. */
export function formatDoctorReport(report: DoctorReport): string[] {
  const lines: string[] = [];
  for (const section of SECTION_ORDER) {
    const sectionFindings = report.findings.filter((finding) => finding.section === section);
    if (sectionFindings.length === 0) {
      continue;
    }
    lines.push("", `${SECTION_TITLES[section]}:`);
    for (const finding of sectionFindings) {
      const subject = finding.subject === undefined ? "" : `${finding.subject}: `;
      lines.push(`  ${severityPrefix(finding.severity)} ${subject}${finding.message}`);
    }
  }
  const failCount = report.findings.filter((finding) => finding.severity === "fail").length;
  lines.push("", report.ok ? "All checks passed." : `${failCount} check(s) failed.`);
  return lines;
}

/**
 * Registers `claude-use doctor` onto `program`.
 *
 * This is the one place in `src/doctor.ts` that performs real I/O: it enumerates every identity and configuration profile on disk, reads every top-level config file as raw text (never pre-parsing — see `runDoctor`'s own doc comment for why), resolves the real Claude Code binary the same way `runClaude` does, and hands everything already-loaded to `runDoctor`. Unlike every other command in this project, a report containing failures is not a thrown error: `doctor` succeeds at producing a full report even when it finds problems, so it sets `process.exitCode` rather than throwing or calling `process.exit()` (which would truncate the report already printed).
 */
export function registerDoctorCommand(program: Command, paths: LayoutPaths): void {
  program
    .command("doctor")
    .description(
      "Audit the whole ~/.claude-use config graph -- every identity, every configuration profile's extends " +
        "chain, directory-rules.json, config.json, categories.local.json, active-identity, and real Claude " +
        "Code binary discoverability. Identity/directory-agnostic, unlike `check`.",
    )
    .action(() => {
      const identityNames = fs.existsSync(paths.identitiesDir)
        ? fs
            .readdirSync(paths.identitiesDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort()
        : [];
      const identities: DoctorIdentityInput[] = identityNames.map((name) => {
        const farmRoot = path.join(paths.identitiesDir, name);
        const identityPath = path.join(farmRoot, "identity.json");
        return { name, path: identityPath, raw: realFsPort.readFileUtf8(identityPath), farmRoot };
      });

      const profileNames = fs.existsSync(paths.configProfilesDir)
        ? fs
            .readdirSync(paths.configProfilesDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
            .map((entry) => entry.name.slice(0, -".json".length))
            .sort()
        : [];
      const configProfiles: DoctorConfigProfileInput[] = profileNames.map((name) => {
        const profilePath = path.join(paths.configProfilesDir, `${name}.json`);
        return { name, path: profilePath, raw: realFsPort.readFileUtf8(profilePath) };
      });

      const ownExecutablePath = realOwnExecutablePath();

      let binaryDiscovery: DoctorBinaryDiscovery;
      try {
        const binary = realResolveClaudeBinary(resolveOwnInstallDirs(paths, ownExecutablePath))();
        binaryDiscovery = { ok: true, binary };
      } catch (error) {
        binaryDiscovery = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }

      const shimState = readJson(paths.claudeShimFile, ClaudeShimStateSchema);

      const report = runDoctor({
        env: process.env,
        identities,
        configProfiles,
        directoryRules: { path: paths.directoryRulesFile, raw: realFsPort.readFileUtf8(paths.directoryRulesFile) },
        globalConfig: { path: paths.globalConfigFile, raw: realFsPort.readFileUtf8(paths.globalConfigFile) },
        categoriesLocal: { path: paths.categoriesLocalFile, raw: realFsPort.readFileUtf8(paths.categoriesLocalFile) },
        activeIdentity: { path: paths.activeIdentityFile, raw: realFsPort.readFileUtf8(paths.activeIdentityFile) },
        binaryDiscovery,
        claudeShim: { state: shimState, targetExists: shimState !== undefined && fs.existsSync(shimState.targetPath) },
        run: realRunPort,
        platform: process.platform,
      });

      for (const line of formatDoctorReport(report)) {
        console.log(line);
      }
      if (!report.ok) {
        process.exitCode = 1;
      }
    });
}

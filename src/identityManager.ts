import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";

import { ConfigValidationError } from "./config/load";
import { applyPatch, readJson, writeJsonAtomic, writeTextAtomic } from "./config/store";
import { IdentitySchema, type Identity } from "./config/schema";
import { realPromptsPort, runProfileWizard, type PromptsPort } from "./configure";
import { CliError } from "./cliError";
import { resolveFarmConflicts, type FarmConflictChoice } from "./launcher/farmResolve";
import { readProfile } from "./configProfiles";
import type { LayoutPaths } from "./paths";
import { realFarmFs } from "./realPorts";

/** Raised by any operation that requires an identity to already exist, when it does not. */
export class IdentityNotFoundError extends CliError {
  constructor(readonly name: string) {
    super(`No identity named "${name}" — run \`claude-use identity add ${name}\` first.`);
    this.name = "IdentityNotFoundError";
  }
}

/** Raised by `addIdentity` when an identity with the given name already has an `identity.json`. */
export class IdentityAlreadyExistsError extends CliError {
  constructor(readonly identityName: string) {
    super(`An identity named "${identityName}" already exists.`);
    this.name = "IdentityAlreadyExistsError";
  }
}

/** Raised by `addIdentity` when `name` fails `IdentitySchema`'s own naming rule — it must start with a letter or number and may then contain letters, numbers, dots, hyphens, underscores, and at signs, so an email address names an identity directly while a *leading* `@` stays invalid (it would collide with the `@name` selector syntax's first-`@` split). */
export class InvalidIdentityNameError extends CliError {
  constructor(readonly attemptedName: string) {
    super(
      `"${attemptedName}" is not a valid identity name — identity names must start with a letter or number and may then contain letters, numbers, dots, hyphens, underscores, and at signs.`,
    );
    this.name = "InvalidIdentityNameError";
  }
}

function identityJsonPath(paths: LayoutPaths, name: string): string {
  return path.join(paths.identitiesDir, name, "identity.json");
}

function identityExists(paths: LayoutPaths, name: string): boolean {
  return fs.existsSync(identityJsonPath(paths, name));
}

/** Reads and validates one identity's `identity.json`, or undefined when it does not exist. */
export function readIdentity(paths: LayoutPaths, name: string): Identity | undefined {
  return readJson(identityJsonPath(paths, name), IdentitySchema);
}

/**
 * Creates a new identity: validates `name` against `IdentitySchema`'s own naming rule and writes a fresh `identity.json` with `allowAmbientCredential: false` and no `defaultConfigProfile`.
 *
 * Throws `IdentityAlreadyExistsError` if an identity with this name already has an `identity.json` — `add` never silently overwrites an existing identity. Throws `InvalidIdentityNameError` when `name` fails `IdentitySchema`'s naming rule, rather than letting the underlying `ZodError` escape as an unhandled crash.
 */
export function addIdentity(paths: LayoutPaths, name: string): Identity {
  if (identityExists(paths, name)) {
    throw new IdentityAlreadyExistsError(name);
  }
  const parsed = IdentitySchema.safeParse({ name, allowAmbientCredential: false });
  if (!parsed.success) {
    throw new InvalidIdentityNameError(name);
  }
  writeJsonAtomic(identityJsonPath(paths, name), parsed.data);
  return parsed.data;
}

/**
 * Persists `name` as the active identity, written atomically as plain text (not JSON — this file is read by `decideIdentity` in `src/launcher/identity.ts` via a simple UTF-8 read-and-trim, matching the README's documented `~/.claude-use/active-identity` file).
 *
 * Throws `IdentityNotFoundError` when no identity with this name exists yet — selecting an identity that hasn't been created would silently persist a name nothing else can ever load.
 */
export function useIdentity(paths: LayoutPaths, name: string): void {
  if (!identityExists(paths, name)) {
    throw new IdentityNotFoundError(name);
  }
  writeTextAtomic(paths.activeIdentityFile, `${name}\n`);
}

/**
 * The interactive setup wizard for a new identity, offered by the `@<name>` shortcut and `identity use` when the identity doesn't exist yet and stdin is a real terminal.
 *
 * Validates `name` against `IdentitySchema`'s own naming rule before any prompt appears — offering "Create it now?" for a name that could never validate (one with a leading `@`, say, or any other character the schema rejects) just to fail on confirm is a broken interaction, so an invalid name throws `InvalidIdentityNameError` immediately instead.
 *
 * Confirms the user wants to create the identity, then optionally creates a default configuration profile (reusing `runProfileWizard`), links them, and sets the identity as active. A cancel at any step writes nothing beyond what was already committed — the identity is only created after the first confirm, and the profile wizard's own cancel handling means a profile-only cancellation still leaves the identity usable. Returns `true` when the identity was created and set active; `false` when the user declined at the initial confirm.
 *
 * Driven entirely by the injected `PromptsPort` so the whole flow is unit-testable with a scripted sequence of answers.
 */
export async function runIdentityWizard(prompts: PromptsPort, paths: LayoutPaths, name: string): Promise<boolean> {
  if (!IdentitySchema.safeParse({ name, allowAmbientCredential: false }).success) {
    throw new InvalidIdentityNameError(name);
  }
  const choice = await prompts.select({
    message: `No identity named "${name}" exists yet. Create it now?`,
    options: [
      { value: "create", label: "Create it" },
      { value: "cancel", label: "Cancel" },
    ],
  });
  if (prompts.isCancel(choice) || choice === "cancel") {
    prompts.cancel("Cancelled.");
    return false;
  }

  addIdentity(paths, name);

  const profileChoice = await prompts.select({
    message: `Create a default configuration profile for "${name}"?`,
    options: [
      { value: "create", label: "Create and configure a profile" },
      { value: "skip", label: "Skip for now" },
    ],
  });
  if (!prompts.isCancel(profileChoice) && profileChoice === "create") {
    const result = await runProfileWizard(prompts, { paths, defaultNewName: name });
    if (result !== undefined) {
      setDefaultConfigProfile(paths, name, result.name);
    }
  }

  useIdentity(paths, name);
  prompts.outro(`Identity "${name}" is set up and active.`);
  return true;
}

/**
 * Handles the `claude-use @<name>` shortcut for `claude-use identity use <name>` — terser, and matches the `@name` convention `run @name`/`claude @name` already use for selecting an identity, rather than introducing a new one.
 *
 * Deliberately requires the `@` prefix and requires `@<name>` to be the *only* argument, rather than also accepting a bare `claude-use <name>`: identity names are user-chosen and unconstrained against the registered subcommand vocabulary (`identity`, `profile`, `rules`, `check`, `configure`, `doctor`, `shim`, `run`), so a bare positional name could collide with a real subcommand — today by an unlikely coincidence, but the tool's own vocabulary only grows over time. `@` makes the token unambiguous on sight and guarantees no future subcommand name can ever collide with it.
 *
 * Returns `false` when `argv` doesn't match this exact one-argument `@name` shape at all, so the caller falls through to normal Commander subcommand dispatch (including its own "unknown command" error for anything else). Returns `true` once handled, whether that meant switching identity or letting `useIdentity`'s own `IdentityNotFoundError` propagate for an unknown name — both are this shortcut's own outcome, not a fallthrough case.
 *
 * When the identity doesn't exist and stdin is a real interactive terminal, the function offers to run `runIdentityWizard` instead of throwing immediately. A non-interactive context (a script, CI) keeps the old behaviour: `IdentityNotFoundError` propagates and prints its one-line message.
 */
export async function tryRunAtIdentityShortcut(paths: LayoutPaths, argv: readonly string[]): Promise<boolean> {
  if (argv.length !== 1) {
    return false;
  }
  const [token] = argv;
  if (token === undefined || !token.startsWith("@") || token.length === 1) {
    return false;
  }
  const name = token.slice(1);
  if (!identityExists(paths, name)) {
    if (process.stdin.isTTY) {
      const created = await runIdentityWizard(realPromptsPort, paths, name);
      if (!created) {
        return true;
      }
    } else {
      useIdentity(paths, name);
    }
  } else {
    useIdentity(paths, name);
  }
  console.log(`Active identity is now "${name}".`);
  return true;
}

/** Reads the persisted active-identity file, or undefined when none is set. */
export function readActiveIdentity(paths: LayoutPaths): string | undefined {
  if (!fs.existsSync(paths.activeIdentityFile)) {
    return undefined;
  }
  const raw = fs.readFileSync(paths.activeIdentityFile, "utf8").trim();
  return raw === "" ? undefined : raw;
}

/**
 * Whether a directory name directly under `identitiesDir` names an actual identity, rather than one of claude-use's own farm directories.
 *
 * `IdentitySchema` requires an identity name to start with a letter or digit, so a leading `.` can only be a resync's own bookkeeping — a `.<identity>.scratch.<suffix>` tree still being built, or a `.<identity>.previous.<suffix>` superseded farm retained for `claude-use identity resolve`. Neither is an identity, and neither should be reported as a broken one for lacking an `identity.json` a resync never put there.
 */
export function isIdentityDirectoryName(name: string): boolean {
  return !name.startsWith(".");
}

/** One identity as reported by `listIdentities`, whose `identity.json` parsed and validated cleanly. */
interface IdentityListEntry {
  readonly name: string;
  readonly identity: Identity;
  readonly isActive: boolean;
  readonly problem?: never;
}

/** One identity whose `identity.json` is present but unreadable — malformed JSON, or valid JSON this version's `IdentitySchema` rejects. `problem` carries the reason, already flattened onto a single line. */
interface UnreadableIdentityListEntry {
  readonly name: string;
  readonly identity?: never;
  readonly isActive: boolean;
  readonly problem: string;
}

/** Either shape `listIdentities` can report, discriminated by which of `identity`/`problem` is present rather than by a tag field — the two are never simultaneously satisfiable. */
export type IdentityListing = IdentityListEntry | UnreadableIdentityListEntry;

/**
 * Reads one identity for `listIdentities`, converting an unreadable `identity.json` into a reportable problem string instead of throwing.
 *
 * Only the two failure modes a *file's own content* can produce are caught: a `SyntaxError` from `JSON.parse`, and the `ConfigValidationError` a schema violation raises. Anything else (a permission error, a directory where a file belongs) still propagates, since those are environment faults rather than one identity's data being bad.
 *
 * A wholly absent `identity.json` is neither — it yields `undefined`, and `listIdentities` skips the entry entirely. That is what keeps `identities/` retained superseded farms (`.<name>.previous.<pid>.<uuid>/`, which are real directories with no `identity.json`) out of the listing.
 */
function readIdentityForListing(paths: LayoutPaths, name: string): Identity | { readonly problem: string } | undefined {
  try {
    return readIdentity(paths, name);
  } catch (error) {
    if (error instanceof ConfigValidationError || error instanceof SyntaxError) {
      return { problem: error.message.replace(/\s*\n\s*/g, " ") };
    }
    throw error;
  }
}

/**
 * Lists every identity under `identitiesDir`, marking which one (if any) is currently active.
 *
 * One identity whose `identity.json` cannot be read is reported as its own `UnreadableIdentityListEntry` rather than aborting the whole listing. A single bad file blocking `identity list` outright is exactly the failure mode that hides every *other* identity from view at the moment the user most needs to see them — and the file need not even be corrupt to land here, since a name written by a newer claude-use whose naming rule has since widened is rejected outright by an older binary's own copy of `IdentitySchema`.
 */
export function listIdentities(paths: LayoutPaths): readonly IdentityListing[] {
  if (!fs.existsSync(paths.identitiesDir)) {
    return [];
  }
  const active = readActiveIdentity(paths);
  const names = fs
    .readdirSync(paths.identitiesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isIdentityDirectoryName(entry.name))
    .map((entry) => entry.name)
    .sort();

  const result: IdentityListing[] = [];
  for (const name of names) {
    const read = readIdentityForListing(paths, name);
    if (read === undefined) {
      continue;
    }
    const isActive = name === active;
    result.push("problem" in read ? { name, isActive, problem: read.problem } : { name, identity: read, isActive });
  }
  return result;
}

/**
 * Sets `identity`'s `defaultConfigProfile` field. Throws `IdentityNotFoundError` when the identity does not exist.
 */
export function setDefaultConfigProfile(paths: LayoutPaths, identityName: string, profileName: string): Identity {
  if (!identityExists(paths, identityName)) {
    throw new IdentityNotFoundError(identityName);
  }
  return applyPatch(identityJsonPath(paths, identityName), IdentitySchema, {
    defaultConfigProfile: profileName,
  });
}

/**
 * Patches `identity`'s `allowAmbientCredential` field. Throws `IdentityNotFoundError` when the identity does not exist.
 */
export function setAllowAmbientCredential(paths: LayoutPaths, identityName: string, allow: boolean): Identity {
  if (!identityExists(paths, identityName)) {
    throw new IdentityNotFoundError(identityName);
  }
  return applyPatch(identityJsonPath(paths, identityName), IdentitySchema, {
    allowAmbientCredential: allow,
  });
}

/** Registers the `claude-use identity` subcommand tree onto `program`. */
export function registerIdentityCommand(program: Command, paths: LayoutPaths): void {
  const identity = program.command("identity").description("Manage claude-use identities (logins).");

  identity
    .command("add <name>")
    .description("Create a new identity.")
    .action((name: string) => {
      addIdentity(paths, name);
      console.log(`Created identity "${name}".`);
    });

  identity
    .command("use <name>")
    .description("Persistently select the active identity.")
    .action(async (name: string) => {
      if (!identityExists(paths, name) && process.stdin.isTTY) {
        const created = await runIdentityWizard(realPromptsPort, paths, name);
        if (!created) {
          return;
        }
      } else {
        useIdentity(paths, name);
      }
      console.log(`Active identity is now "${name}".`);
    });

  identity
    .command("resolve <name>")
    .description("Interactively resolve a superseded farm's colliding data left behind by a prior launch.")
    .action(async (name: string) => {
      const result = await resolveFarmConflicts({
        fs: realFarmFs,
        identitiesDir: paths.identitiesDir,
        identity: name,
        decide: async (conflict) => {
          const choice = await realPromptsPort.select<FarmConflictChoice>({
            message:
              `"${conflict.name}" exists both in the superseded farm (${conflict.previousRoot}) and the ` +
              `current one (${conflict.farmRoot}). Which should be kept?`,
            options: [
              { value: "keep-new", label: "Keep the current farm's copy", hint: "discards the superseded one" },
              { value: "keep-old", label: "Keep the superseded farm's copy", hint: "replaces the current one" },
              { value: "skip", label: "Skip for now", hint: "leaves both copies, asks again next time" },
            ],
          });
          return realPromptsPort.isCancel(choice) ? "skip" : choice;
        },
      });

      if (result.resolved.length === 0) {
        console.log(`No superseded farm data to resolve for identity "${name}".`);
        return;
      }
      for (const conflict of result.resolved) {
        console.log(`  ${conflict.name}: ${conflict.choice}`);
      }
      console.log(
        `Resolved ${result.resolved.length} conflict(s) — ${result.removed.length} superseded director(ies) fully ` +
          `cleared, ${result.retained.length} still retained pending a skipped conflict.`,
      );
    });

  identity
    .command("list")
    .description("List every identity, marking the active one.")
    .action(() => {
      const entries = listIdentities(paths);
      if (entries.length === 0) {
        console.log("No identities yet. Run `claude-use identity add <name>` to create one.");
        return;
      }
      for (const entry of entries) {
        const marker = entry.isActive ? "* " : "  ";
        if (entry.problem !== undefined) {
          console.log(`${marker}${entry.name} [unreadable: ${entry.problem}]`);
          continue;
        }
        const defaultProfile =
          entry.identity.defaultConfigProfile !== undefined
            ? ` (default profile: ${entry.identity.defaultConfigProfile})`
            : "";
        const ambient = entry.identity.allowAmbientCredential ? " [allows ambient credential]" : "";
        console.log(`${marker}${entry.name}${defaultProfile}${ambient}`);
      }
      if (entries.some((entry) => entry.problem !== undefined)) {
        console.log("\nRun `claude-use doctor` for the full detail on every unreadable entry.");
      }
    });

  identity
    .command("set-default-profile <identity> <profile>")
    .description("Set an identity's default configuration profile.")
    .action(async (identityName: string, profileName: string) => {
      if (readProfile(paths, profileName) === undefined) {
        const result = await runProfileWizard(realPromptsPort, {
          paths,
          defaultNewName: profileName,
        });
        if (result === undefined) {
          console.log(`No configuration profile named "${profileName}" was created; nothing changed.`);
          return;
        }
        if (result.name !== profileName) {
          console.log(
            `Created configuration profile "${result.name}" instead of "${profileName}". Set the identity's default to that name explicitly if that wasn't intended.`,
          );
        }
        setDefaultConfigProfile(paths, identityName, result.name);
        console.log(`Identity "${identityName}" now defaults to configuration profile "${result.name}".`);
        return;
      }
      setDefaultConfigProfile(paths, identityName, profileName);
      console.log(`Identity "${identityName}" now defaults to configuration profile "${profileName}".`);
    });

  identity
    .command("set <name>")
    .description("Update an identity's own settings.")
    .option("--allow-ambient-credential", "Allow this identity to launch even with an ambient credential env var set.")
    .option("--no-allow-ambient-credential", "Disallow ambient credential env vars for this identity (the default).")
    .action((name: string, options: { allowAmbientCredential?: boolean }) => {
      if (options.allowAmbientCredential === undefined) {
        console.log("Nothing to change: pass --allow-ambient-credential or --no-allow-ambient-credential.");
        return;
      }
      setAllowAmbientCredential(paths, name, options.allowAmbientCredential);
      console.log(
        `Identity "${name}" ${options.allowAmbientCredential ? "now allows" : "no longer allows"} an ambient credential.`,
      );
    });
}

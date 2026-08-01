import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";

import { applyPatch, readJson, writeJsonAtomic, writeTextAtomic } from "./config/store";
import { IdentitySchema, type Identity } from "./config/schema";
import type { LayoutPaths } from "./paths";

/** Raised by any operation that requires an identity to already exist, when it does not. */
export class IdentityNotFoundError extends Error {
  constructor(readonly name: string) {
    super(`No identity named "${name}" — run \`claude-use identity add ${name}\` first.`);
    this.name = "IdentityNotFoundError";
  }
}

/** Raised by `addIdentity` when an identity with the given name already has an `identity.json`. */
export class IdentityAlreadyExistsError extends Error {
  constructor(readonly identityName: string) {
    super(`An identity named "${identityName}" already exists.`);
    this.name = "IdentityAlreadyExistsError";
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
 * Throws `IdentityAlreadyExistsError` if an identity with this name already has an `identity.json` — `add` never silently overwrites an existing identity.
 */
export function addIdentity(paths: LayoutPaths, name: string): Identity {
  if (identityExists(paths, name)) {
    throw new IdentityAlreadyExistsError(name);
  }
  const identity = IdentitySchema.parse({ name, allowAmbientCredential: false });
  writeJsonAtomic(identityJsonPath(paths, name), identity);
  return identity;
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

/** Reads the persisted active-identity file, or undefined when none is set. */
export function readActiveIdentity(paths: LayoutPaths): string | undefined {
  if (!fs.existsSync(paths.activeIdentityFile)) {
    return undefined;
  }
  const raw = fs.readFileSync(paths.activeIdentityFile, "utf8").trim();
  return raw === "" ? undefined : raw;
}

/** One identity as reported by `listIdentities`. */
export interface IdentityListEntry {
  readonly name: string;
  readonly identity: Identity;
  readonly isActive: boolean;
}

/** Lists every identity under `identitiesDir` that has a valid `identity.json`, marking which one (if any) is currently active. */
export function listIdentities(paths: LayoutPaths): readonly IdentityListEntry[] {
  if (!fs.existsSync(paths.identitiesDir)) {
    return [];
  }
  const active = readActiveIdentity(paths);
  const names = fs
    .readdirSync(paths.identitiesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const result: IdentityListEntry[] = [];
  for (const name of names) {
    const identity = readIdentity(paths, name);
    if (identity !== undefined) {
      result.push({ name, identity, isActive: name === active });
    }
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
    .action((name: string) => {
      useIdentity(paths, name);
      console.log(`Active identity is now "${name}".`);
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
        const defaultProfile =
          entry.identity.defaultConfigProfile !== undefined
            ? ` (default profile: ${entry.identity.defaultConfigProfile})`
            : "";
        const ambient = entry.identity.allowAmbientCredential ? " [allows ambient credential]" : "";
        console.log(`${marker}${entry.name}${defaultProfile}${ambient}`);
      }
    });

  identity
    .command("set-default-profile <identity> <profile>")
    .description("Set an identity's default configuration profile.")
    .action((identityName: string, profileName: string) => {
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

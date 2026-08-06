import type { Command } from "commander";

import { readJson, writeJsonAtomic } from "./config/store";
import { DirectoryRulesSchema, type DirectoryRule, type DirectoryRules } from "./config/schema";
import { CliError } from "./cliError";
import { realPromptsPort, runProfileWizard } from "./configure";
import { readProfile } from "./configProfiles";
import type { LayoutPaths } from "./paths";

/** Raised by `removeRule` when no rule matches the given path exactly. */
export class DirectoryRuleNotFoundError extends CliError {
  constructor(readonly rulePath: string) {
    super(`No directory rule found for path "${rulePath}".`);
    this.name = "DirectoryRuleNotFoundError";
  }
}

/** Reads `~/.claude-use/directory-rules.json`, or an empty rule set when the file does not exist yet. */
export function readDirectoryRules(paths: LayoutPaths): DirectoryRules {
  return readJson(paths.directoryRulesFile, DirectoryRulesSchema) ?? { rules: [] };
}

/** Validates and writes the whole `~/.claude-use/directory-rules.json` file. Exported so `src/configure.ts` can update a single rule's `categories`/`entries` in place without duplicating this validate-then-write step. */
export function writeDirectoryRules(paths: LayoutPaths, rules: DirectoryRules): void {
  const validated = DirectoryRulesSchema.parse(rules);
  writeJsonAtomic(paths.directoryRulesFile, validated);
}

/** Lists every directory rule, in file order. */
export function listDirectoryRules(paths: LayoutPaths): readonly DirectoryRule[] {
  return readDirectoryRules(paths).rules;
}

/** Inputs to `addDirectoryRule` beyond the path itself. */
export interface AddDirectoryRuleOptions {
  readonly configProfile?: string;
  readonly identity?: string;
}

/**
 * Adds a directory rule for `rulePath`, or updates the existing rule for that exact path if one is already present — a second `add` for the same path is an update, not a duplicate entry.
 *
 * At least one of `configProfile`/`identity` must be given; a rule that pins neither would do nothing.
 */
export function addDirectoryRule(paths: LayoutPaths, rulePath: string, options: AddDirectoryRuleOptions): DirectoryRule {
  if (options.configProfile === undefined && options.identity === undefined) {
    throw new Error("A directory rule must set at least one of --profile or --identity.");
  }
  const current = readDirectoryRules(paths);
  const existingIndex = current.rules.findIndex((rule) => rule.path === rulePath);

  let updated: DirectoryRule;
  if (existingIndex === -1) {
    updated = buildNewRule(rulePath, options);
    writeDirectoryRules(paths, { ...current, rules: [...current.rules, updated] });
  } else {
    const existingRule = current.rules[existingIndex]!;
    updated = {
      ...existingRule,
      ...(options.configProfile !== undefined ? { configProfile: options.configProfile } : {}),
      ...(options.identity !== undefined ? { identity: options.identity } : {}),
    };
    const nextRules = [...current.rules];
    nextRules[existingIndex] = updated;
    writeDirectoryRules(paths, { ...current, rules: nextRules });
  }
  return updated;
}

function buildNewRule(rulePath: string, options: AddDirectoryRuleOptions): DirectoryRule {
  return {
    path: rulePath,
    ...(options.configProfile !== undefined ? { configProfile: options.configProfile } : {}),
    ...(options.identity !== undefined ? { identity: options.identity } : {}),
  };
}

/** Removes the directory rule for `rulePath`. Throws `DirectoryRuleNotFoundError` when no rule matches that exact path. */
export function removeDirectoryRule(paths: LayoutPaths, rulePath: string): void {
  const current = readDirectoryRules(paths);
  const nextRules = current.rules.filter((rule) => rule.path !== rulePath);
  if (nextRules.length === current.rules.length) {
    throw new DirectoryRuleNotFoundError(rulePath);
  }
  writeDirectoryRules(paths, { ...current, rules: nextRules });
}

/** Registers the `claude-use rules` subcommand tree onto `program`. */
export function registerRulesCommand(program: Command, paths: LayoutPaths): void {
  const rules = program.command("rules").description("Manage directory-scoped identity/profile pins.");

  rules
    .command("add <path>")
    .description("Add or update a directory rule.")
    .option("--profile <name>", "Configuration profile to select for this path.")
    .option("--identity <name>", "Identity to pin for this path.")
    .action(async (rulePath: string, options: { profile?: string; identity?: string }) => {
      let profileName = options.profile;
      if (profileName !== undefined && readProfile(paths, profileName) === undefined) {
        const result = await runProfileWizard(realPromptsPort, { paths, defaultNewName: profileName });
        if (result === undefined) {
          console.log(`No configuration profile named "${profileName}" was created; the rule pins identity only.`);
          profileName = undefined;
        } else {
          if (result.name !== options.profile) {
            console.log(
              `Created configuration profile "${result.name}" instead of "${options.profile}". The rule selects that name.`,
            );
          }
          profileName = result.name;
        }
      }
      addDirectoryRule(paths, rulePath, { configProfile: profileName, identity: options.identity });
      console.log(`Directory rule for "${rulePath}" saved.`);
    });

  rules
    .command("list")
    .description("List every directory rule.")
    .action(() => {
      const entries = listDirectoryRules(paths);
      if (entries.length === 0) {
        console.log("No directory rules yet. Run `claude-use rules add <path>` to create one.");
        return;
      }
      for (const rule of entries) {
        const parts = [
          rule.configProfile !== undefined ? `profile=${rule.configProfile}` : undefined,
          rule.identity !== undefined ? `identity=${rule.identity}` : undefined,
        ].filter((part): part is string => part !== undefined);
        console.log(`  ${rule.path} (${parts.join(", ")})`);
      }
    });

  rules
    .command("remove <path>")
    .description("Remove the directory rule for a path.")
    .action((rulePath: string) => {
      removeDirectoryRule(paths, rulePath);
      console.log(`Removed directory rule for "${rulePath}".`);
    });
}

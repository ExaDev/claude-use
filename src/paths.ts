import os from "node:os";
import path from "node:path";

/**
 * The resolved set of paths claude-use reads and writes under its own root.
 *
 * `root` is always CLAUDE_USE_HOME when that environment variable is set (used by every test in this project, and by any real installation that wants to relocate its state), falling back to `~/.claude-use` only when the variable is unset. Every other field is derived from `root` so there is exactly one place a path can go wrong.
 */
export interface LayoutPaths {
  /** The resolved root directory — CLAUDE_USE_HOME, or ~/.claude-use when unset. */
  readonly root: string;
  /** Directory holding one subdirectory per identity (symlink farm + local credentials/daemon state). */
  readonly identitiesDir: string;
  /** Directory holding named, reusable configuration profile JSON files. */
  readonly configProfilesDir: string;
  /** Path to the directory-rules.json file describing directory-scoped identity/profile pins. */
  readonly directoryRulesFile: string;
  /** Path to the persisted active-identity file (the identity `claude-use identity use` selected). */
  readonly activeIdentityFile: string;
  /** Path to the global config.json (user-global override layer, and default profile/walk-limit settings). */
  readonly globalConfigFile: string;
  /** Path to the categories.local.json overlay recording answers to "unclassified entry" prompts. */
  readonly categoriesLocalFile: string;
}

/**
 * Resolves the current CLAUDE_USE_HOME root: the environment variable when set to a non-empty string, otherwise `~/.claude-use`. An empty string counts as unset, consistent with how this project treats empty-string environment variables elsewhere (see the ambient-credential guard).
 */
export function resolveClaudeUseHome(): string {
  const fromEnv = process.env.CLAUDE_USE_HOME;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  return path.join(os.homedir(), ".claude-use");
}

/** Builds the full LayoutPaths structure from a given root directory. */
export function buildLayoutPaths(root: string): LayoutPaths {
  return {
    root,
    identitiesDir: path.join(root, "identities"),
    configProfilesDir: path.join(root, "config-profiles"),
    directoryRulesFile: path.join(root, "directory-rules.json"),
    activeIdentityFile: path.join(root, "active-identity"),
    globalConfigFile: path.join(root, "config.json"),
    categoriesLocalFile: path.join(root, "categories.local.json"),
  };
}

/** Resolves CLAUDE_USE_HOME and builds the full LayoutPaths structure in one call. */
export function resolveLayoutPaths(): LayoutPaths {
  return buildLayoutPaths(resolveClaudeUseHome());
}

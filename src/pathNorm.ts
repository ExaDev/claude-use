import path from "node:path";

/**
 * Expands a leading `~` against `home`.
 *
 * Only a leading `~` alone or followed by a separator is expanded — `~other` is a literal name (a directory really called that), not another user's home directory, which this tool has no business resolving.
 */
export function expandTilde(value: string, home: string): string {
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/")) {
    return path.join(home, value.slice(2));
  }
  return value;
}

/**
 * Normalises a directory rule's `path` into an absolute filesystem path for comparison against a real directory.
 *
 * Rules are written with `~`-rooted paths far more often than absolute ones, and a rule that fails to match because of a trailing slash or a `..` segment fails silently — the launch just quietly ignores the rule. Normalising both sides identically is what stops that.
 */
export function normaliseRulePath(rulePath: string, home: string): string {
  return path.resolve(expandTilde(rulePath, home));
}

/** True when `ancestor` is `descendant` itself or one of its parent directories. Both are expected to be already normalised. */
export function isAncestorOrSelf(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) {
    return true;
  }
  const withSeparator = ancestor.endsWith(path.sep) ? ancestor : `${ancestor}${path.sep}`;
  return descendant.startsWith(withSeparator);
}

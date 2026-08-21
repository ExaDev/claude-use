import { describe, expect, it } from "vitest";

import { CliError } from "./cliError";
import { IdentityAlreadyExistsError, IdentityNotFoundError, InvalidIdentityNameError } from "./identityManager";
import { InvalidCategoryNameError, ProfileAlreadyExistsError, ProfileNotFoundError } from "./configProfiles";
import { DirectoryRuleNotFoundError } from "./directoryRules";
import { ForeignClaudeEntryError, UnsupportedShimSourceError } from "./claudeShim";
import { ConfigValidationError } from "./config/load";
import { InvalidCliCategoryError, InvalidCliEntryKeyError } from "./launcher/cliOverride";
import { IdentityLockBusyError } from "./launcher/lock";
import { UnrootedProjectPathError } from "./resolve/projects";
import { EntryKeyError } from "./resolve/match";

/**
 * Every custom error this CLI throws to represent an expected, user-facing failure must extend `CliError` -- that is what makes `main()` in `src/cli.ts` print it as a clean one-line message instead of a raw stack trace. This test exists specifically to catch a class silently reverting to `extends Error`, or a new one being added without extending `CliError` at all, neither of which `tsc`/`eslint` would ever flag.
 */
describe("every CLI-facing error class extends CliError", () => {
  it.each<[string, () => Error]>([
    ["IdentityNotFoundError", () => new IdentityNotFoundError("work")],
    ["IdentityAlreadyExistsError", () => new IdentityAlreadyExistsError("work")],
    ["InvalidIdentityNameError", () => new InvalidIdentityNameError("bad@name")],
    ["ProfileNotFoundError", () => new ProfileNotFoundError("client-acme")],
    ["ProfileAlreadyExistsError", () => new ProfileAlreadyExistsError("client-acme")],
    ["InvalidCategoryNameError", () => new InvalidCategoryNameError("secret")],
    ["DirectoryRuleNotFoundError", () => new DirectoryRuleNotFoundError("/some/path")],
    ["ForeignClaudeEntryError", () => new ForeignClaudeEntryError("/usr/local/bin/claude", "enable")],
    ["UnsupportedShimSourceError", () => new UnsupportedShimSourceError("/some/source")],
    ["ConfigValidationError", () => new ConfigValidationError("/some/config.json", [])],
    ["InvalidCliCategoryError", () => new InvalidCliCategoryError("secret")],
    ["InvalidCliEntryKeyError", () => new InvalidCliEntryKeyError("no-prefix")],
    ["IdentityLockBusyError", () => new IdentityLockBusyError("work", "/some/lock", 42)],
    ["UnrootedProjectPathError", () => new UnrootedProjectPathError("relative/path")],
    ["EntryKeyError", () => new EntryKeyError("bad-key", "bad", "malformed")],
  ])("%s extends CliError", (_name, construct) => {
    expect(construct()).toBeInstanceOf(CliError);
  });
});

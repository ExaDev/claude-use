import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildLayoutPaths, type LayoutPaths } from "./paths";
import type { MultiselectParams, PromptsPort, SelectParams } from "./configure";
import {
  IdentityAlreadyExistsError,
  IdentityNotFoundError,
  InvalidIdentityNameError,
  addIdentity,
  listIdentities,
  readActiveIdentity,
  readIdentity,
  runIdentityWizard,
  setAllowAmbientCredential,
  setDefaultConfigProfile,
  tryRunAtIdentityShortcut,
  useIdentity,
} from "./identityManager";

/** A scripted `PromptsPort` for identity wizard tests: each call consumes the next answer in order. */
function scriptedIdentityPrompts(answers: readonly unknown[]): PromptsPort {
  let index = 0;
  const next = (): unknown => {
    const value = answers[index];
    index += 1;
    return value;
  };
  return {
    select: <Value extends string>(params: SelectParams<Value>): Promise<Value | symbol> => {
      const answer = next();
      if (typeof answer === "symbol") return Promise.resolve(answer);
      const option = params.options.find((o) => o.value === answer);
      if (option === undefined) throw new Error(`scripted select answer not in options: ${String(answer)}`);
      return Promise.resolve(option.value);
    },
    multiselect: <Value extends string>(params: MultiselectParams<Value>): Promise<readonly Value[] | symbol> => {
      const answer = next();
      if (typeof answer === "symbol") return Promise.resolve(answer);
      if (!Array.isArray(answer)) throw new Error(`scripted multiselect answer is not an array: ${String(answer)}`);
      const selected: Value[] = [];
      for (const item of answer) {
        const option = params.options.find((o) => o.value === item);
        if (option === undefined) throw new Error(`scripted multiselect answer not in options: ${String(item)}`);
        selected.push(option.value);
      }
      return Promise.resolve(selected);
    },
    text: (): Promise<string | symbol> => {
      const answer = next();
      if (typeof answer === "symbol") return Promise.resolve(answer);
      if (typeof answer !== "string") throw new Error(`scripted text answer is not a string: ${String(answer)}`);
      return Promise.resolve(answer);
    },
    isCancel: (value: unknown): value is symbol => typeof value === "symbol",
    cancel: () => undefined,
    intro: () => undefined,
    outro: () => undefined,
  };
}

describe("identityManager", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-manager-test-"));
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("addIdentity", () => {
    it("creates a fresh identity.json with the expected defaults", () => {
      const identity = addIdentity(paths, "work");
      expect(identity).toEqual({ name: "work", allowAmbientCredential: false });
      expect(readIdentity(paths, "work")).toEqual(identity);
    });

    it("throws IdentityAlreadyExistsError when the identity already exists", () => {
      addIdentity(paths, "work");
      expect(() => addIdentity(paths, "work")).toThrow(IdentityAlreadyExistsError);
    });

    it("throws InvalidIdentityNameError, not a raw ZodError, for a name that fails IdentitySchema's own naming rule", () => {
      expect(() => addIdentity(paths, "-bad-start")).toThrow(InvalidIdentityNameError);
    });

    it("throws InvalidIdentityNameError for an email-shaped name (the `@` shortcut's own name portion can be anything, including an email address)", () => {
      expect(() => addIdentity(paths, "joseph.mearman@exadev.io")).toThrow(InvalidIdentityNameError);
    });
  });

  describe("readIdentity", () => {
    it("returns undefined for an identity that does not exist", () => {
      expect(readIdentity(paths, "nope")).toBeUndefined();
    });
  });

  describe("useIdentity / readActiveIdentity", () => {
    it("throws IdentityNotFoundError when selecting an identity that was never created", () => {
      expect(() => useIdentity(paths, "ghost")).toThrow(IdentityNotFoundError);
    });

    it("persists the active identity as plain trimmed text", () => {
      addIdentity(paths, "personal");
      useIdentity(paths, "personal");
      expect(fs.readFileSync(paths.activeIdentityFile, "utf8")).toBe("personal\n");
      expect(readActiveIdentity(paths)).toBe("personal");
    });

    it("returns undefined when no active identity has been set", () => {
      expect(readActiveIdentity(paths)).toBeUndefined();
    });

    it("switching the active identity overwrites the previous selection", () => {
      addIdentity(paths, "personal");
      addIdentity(paths, "work");
      useIdentity(paths, "personal");
      useIdentity(paths, "work");
      expect(readActiveIdentity(paths)).toBe("work");
    });
  });

  describe("tryRunAtIdentityShortcut", () => {
    it("switches the active identity for a bare @<name> argument", async () => {
      addIdentity(paths, "exadev");
      expect(await tryRunAtIdentityShortcut(paths, ["@exadev"])).toBe(true);
      expect(readActiveIdentity(paths)).toBe("exadev");
    });

    it("propagates IdentityNotFoundError for an unknown @<name> in a non-interactive context", async () => {
      await expect(tryRunAtIdentityShortcut(paths, ["@ghost"])).rejects.toThrow(IdentityNotFoundError);
    });

    it("returns false and touches nothing for a bare name with no @ prefix", async () => {
      addIdentity(paths, "exadev");
      expect(await tryRunAtIdentityShortcut(paths, ["exadev"])).toBe(false);
      expect(readActiveIdentity(paths)).toBeUndefined();
    });

    it("returns false for a lone @ with no name", async () => {
      expect(await tryRunAtIdentityShortcut(paths, ["@"])).toBe(false);
    });

    it("returns false when there is more than one argument, even if the first is @<name>", async () => {
      addIdentity(paths, "exadev");
      expect(await tryRunAtIdentityShortcut(paths, ["@exadev", "extra"])).toBe(false);
      expect(readActiveIdentity(paths)).toBeUndefined();
    });

    it("returns false for no arguments at all", async () => {
      expect(await tryRunAtIdentityShortcut(paths, [])).toBe(false);
    });

    it("returns false for a real subcommand name, leaving it to Commander's own dispatch", async () => {
      expect(await tryRunAtIdentityShortcut(paths, ["identity"])).toBe(false);
    });
  });

  describe("runIdentityWizard", () => {
    it("creates the identity, a profile, and sets it as active when the user accepts every step", async () => {
      const prompts = scriptedIdentityPrompts(["create", "create", "work", ["history"]]);
      const result = await runIdentityWizard(prompts, paths, "scienap");

      expect(result).toBe(true);
      expect(readIdentity(paths, "scienap")).toBeDefined();
      expect(readActiveIdentity(paths)).toBe("scienap");
      expect(readIdentity(paths, "scienap")?.defaultConfigProfile).toBe("work");
    });

    it("creates only the identity when the user skips profile creation", async () => {
      const prompts = scriptedIdentityPrompts(["create", "skip"]);
      const result = await runIdentityWizard(prompts, paths, "personal");

      expect(result).toBe(true);
      expect(readIdentity(paths, "personal")).toBeDefined();
      expect(readActiveIdentity(paths)).toBe("personal");
      expect(readIdentity(paths, "personal")?.defaultConfigProfile).toBeUndefined();
    });

    it("creates nothing and returns false when the user declines at the initial confirm", async () => {
      const prompts = scriptedIdentityPrompts(["cancel"]);
      const result = await runIdentityWizard(prompts, paths, "ghost");

      expect(result).toBe(false);
      expect(readIdentity(paths, "ghost")).toBeUndefined();
      expect(readActiveIdentity(paths)).toBeUndefined();
    });

    it("throws InvalidIdentityNameError, not a raw ZodError, when the confirmed name fails IdentitySchema's own naming rule", async () => {
      const prompts = scriptedIdentityPrompts(["create"]);
      await expect(runIdentityWizard(prompts, paths, "joseph.mearman@exadev.io")).rejects.toThrow(
        InvalidIdentityNameError,
      );
    });
  });

  describe("listIdentities", () => {
    it("returns an empty list when no identities exist", () => {
      expect(listIdentities(paths)).toEqual([]);
    });

    it("lists every identity sorted by name and marks the active one", () => {
      addIdentity(paths, "work");
      addIdentity(paths, "personal");
      useIdentity(paths, "personal");

      const entries = listIdentities(paths);
      expect(entries.map((entry) => entry.name)).toEqual(["personal", "work"]);
      expect(entries.find((entry) => entry.name === "personal")?.isActive).toBe(true);
      expect(entries.find((entry) => entry.name === "work")?.isActive).toBe(false);
    });

    it("skips a directory under identitiesDir that has no valid identity.json", () => {
      addIdentity(paths, "work");
      fs.mkdirSync(path.join(paths.identitiesDir, "not-an-identity"), { recursive: true });
      const entries = listIdentities(paths);
      expect(entries.map((entry) => entry.name)).toEqual(["work"]);
    });
  });

  describe("setDefaultConfigProfile", () => {
    it("patches defaultConfigProfile on an existing identity", () => {
      addIdentity(paths, "work");
      const updated = setDefaultConfigProfile(paths, "work", "client-acme");
      expect(updated.defaultConfigProfile).toBe("client-acme");
      expect(readIdentity(paths, "work")?.defaultConfigProfile).toBe("client-acme");
    });

    it("throws IdentityNotFoundError for a missing identity", () => {
      expect(() => setDefaultConfigProfile(paths, "ghost", "client-acme")).toThrow(IdentityNotFoundError);
    });

    it("preserves the identity's other fields when patching", () => {
      addIdentity(paths, "work");
      setAllowAmbientCredential(paths, "work", true);
      const updated = setDefaultConfigProfile(paths, "work", "client-acme");
      expect(updated.allowAmbientCredential).toBe(true);
    });
  });

  describe("setAllowAmbientCredential", () => {
    it("patches allowAmbientCredential to true", () => {
      addIdentity(paths, "work");
      const updated = setAllowAmbientCredential(paths, "work", true);
      expect(updated.allowAmbientCredential).toBe(true);
    });

    it("patches allowAmbientCredential back to false", () => {
      addIdentity(paths, "work");
      setAllowAmbientCredential(paths, "work", true);
      const updated = setAllowAmbientCredential(paths, "work", false);
      expect(updated.allowAmbientCredential).toBe(false);
    });

    it("throws IdentityNotFoundError for a missing identity", () => {
      expect(() => setAllowAmbientCredential(paths, "ghost", true)).toThrow(IdentityNotFoundError);
    });
  });
});

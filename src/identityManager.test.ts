import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildLayoutPaths, type LayoutPaths } from "./paths";
import {
  IdentityAlreadyExistsError,
  IdentityNotFoundError,
  addIdentity,
  listIdentities,
  readActiveIdentity,
  readIdentity,
  setAllowAmbientCredential,
  setDefaultConfigProfile,
  tryRunAtIdentityShortcut,
  useIdentity,
} from "./identityManager";

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

    it("rejects an invalid identity name via IdentitySchema's own regex", () => {
      expect(() => addIdentity(paths, "-bad-start")).toThrow();
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
    it("switches the active identity for a bare @<name> argument", () => {
      addIdentity(paths, "exadev");
      expect(tryRunAtIdentityShortcut(paths, ["@exadev"])).toBe(true);
      expect(readActiveIdentity(paths)).toBe("exadev");
    });

    it("propagates IdentityNotFoundError for an unknown @<name>, same as identity use", () => {
      expect(() => tryRunAtIdentityShortcut(paths, ["@ghost"])).toThrow(IdentityNotFoundError);
    });

    it("returns false and touches nothing for a bare name with no @ prefix", () => {
      addIdentity(paths, "exadev");
      expect(tryRunAtIdentityShortcut(paths, ["exadev"])).toBe(false);
      expect(readActiveIdentity(paths)).toBeUndefined();
    });

    it("returns false for a lone @ with no name", () => {
      expect(tryRunAtIdentityShortcut(paths, ["@"])).toBe(false);
    });

    it("returns false when there is more than one argument, even if the first is @<name>", () => {
      addIdentity(paths, "exadev");
      expect(tryRunAtIdentityShortcut(paths, ["@exadev", "extra"])).toBe(false);
      expect(readActiveIdentity(paths)).toBeUndefined();
    });

    it("returns false for no arguments at all", () => {
      expect(tryRunAtIdentityShortcut(paths, [])).toBe(false);
    });

    it("returns false for a real subcommand name, leaving it to Commander's own dispatch", () => {
      expect(tryRunAtIdentityShortcut(paths, ["identity"])).toBe(false);
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

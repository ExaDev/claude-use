import { describe, expect, it } from "vitest";
import {
  compareVersions,
  discoverClaudeBinary,
  isNumericDottedVersion,
  pickHighestVersion,
  type VersionsDirEntry,
} from "./versionDiscovery";

function file(name: string, opts: Partial<Omit<VersionsDirEntry, "name">> = {}): VersionsDirEntry {
  return {
    name,
    isFile: true,
    isExecutable: true,
    sizeBytes: 1024,
    ...opts,
  };
}

describe("isNumericDottedVersion", () => {
  it("accepts plain dotted-numeric strings", () => {
    expect(isNumericDottedVersion("2.1.220")).toBe(true);
    expect(isNumericDottedVersion("1")).toBe(true);
    expect(isNumericDottedVersion("10.0")).toBe(true);
  });

  it("rejects non-numeric or malformed names", () => {
    expect(isNumericDottedVersion(".DS_Store")).toBe(false);
    expect(isNumericDottedVersion("2.1.220-beta")).toBe(false);
    expect(isNumericDottedVersion("")).toBe(false);
    expect(isNumericDottedVersion("2..1")).toBe(false);
    expect(isNumericDottedVersion("v2.1.220")).toBe(false);
  });
});

describe("compareVersions", () => {
  it("compares numerically, not lexicographically", () => {
    expect(compareVersions("2.9.0", "2.10.0")).toBeLessThan(0);
    expect(compareVersions("2.10.0", "2.9.0")).toBeGreaterThan(0);
  });

  it("treats a missing trailing segment as 0", () => {
    expect(compareVersions("2.1", "2.1.0")).toBe(0);
    expect(compareVersions("2.1", "2.1.1")).toBeLessThan(0);
    expect(compareVersions("2.1.1", "2.1")).toBeGreaterThan(0);
  });

  it("returns 0 for identical versions", () => {
    expect(compareVersions("2.1.220", "2.1.220")).toBe(0);
  });

  it("throws for a non-numeric-dotted input", () => {
    expect(() => compareVersions("not-a-version", "2.1.220")).toThrow();
    expect(() => compareVersions("2.1.220", "not-a-version")).toThrow();
  });
});

describe("pickHighestVersion", () => {
  it("picks the highest version by real numeric comparison", () => {
    const entries = [file("2.1.220"), file("2.9.0"), file("2.10.0"), file("1.99.99")];
    expect(pickHighestVersion(entries)).toBe("2.10.0");
  });

  it("skips non-file entries (e.g. a directory)", () => {
    const entries = [file("2.1.220"), file("9.9.9", { isFile: false })];
    expect(pickHighestVersion(entries)).toBe("2.1.220");
  });

  it("skips non-executable entries", () => {
    const entries = [file("2.1.220"), file("9.9.9", { isExecutable: false })];
    expect(pickHighestVersion(entries)).toBe("2.1.220");
  });

  it("skips zero-size entries", () => {
    const entries = [file("2.1.220"), file("9.9.9", { sizeBytes: 0 })];
    expect(pickHighestVersion(entries)).toBe("2.1.220");
  });

  it("skips entries whose name isn't a valid numeric-dotted version, like .DS_Store", () => {
    const entries = [file("2.1.220"), file(".DS_Store")];
    expect(pickHighestVersion(entries)).toBe("2.1.220");
  });

  it("returns undefined when nothing qualifies (missing/empty versions dir)", () => {
    expect(pickHighestVersion([])).toBeUndefined();
    expect(pickHighestVersion([file(".DS_Store"), file("9.9.9", { sizeBytes: 0 })])).toBeUndefined();
  });
});

describe("discoverClaudeBinary", () => {
  it("prefers the highest version from the versions directory", () => {
    const result = discoverClaudeBinary({
      versionsDir: "/fake/versions",
      listVersionsDir: () => [file("2.1.220"), file("2.10.0")],
      pathDirs: ["/fake/bin"],
      findExecutableInDir: () => undefined,
      ownInstallDirs: [],
    });

    expect(result.source).toBe("versions-dir");
    expect(result.version).toBe("2.10.0");
    expect(result.path).toBe("/fake/versions/2.10.0");
  });

  it("falls back to PATH when the versions directory has nothing usable", () => {
    const result = discoverClaudeBinary({
      versionsDir: "/fake/versions",
      listVersionsDir: () => [],
      pathDirs: ["/fake/own-install", "/fake/other-bin"],
      findExecutableInDir: (dir, name) => (dir === "/fake/other-bin" ? `${dir}/${name}` : undefined),
      ownInstallDirs: ["/fake/own-install"],
    });

    expect(result.source).toBe("path-fallback");
    expect(result.path).toBe("/fake/other-bin/claude");
  });

  it("excludes this tool's own install directory from the PATH fallback", () => {
    expect(() =>
      discoverClaudeBinary({
        versionsDir: "/fake/versions",
        listVersionsDir: () => [],
        pathDirs: ["/fake/own-install"],
        findExecutableInDir: (dir, name) => `${dir}/${name}`,
        ownInstallDirs: ["/fake/own-install"],
      }),
    ).toThrow(/Could not find a claude binary/);
  });

  it("throws a clear, actionable error when nothing is found anywhere, never crashing silently", () => {
    expect(() =>
      discoverClaudeBinary({
        versionsDir: "/fake/versions",
        listVersionsDir: () => [],
        pathDirs: [],
        findExecutableInDir: () => undefined,
        ownInstallDirs: [],
      }),
    ).toThrow(/Could not find a claude binary/);
  });
});

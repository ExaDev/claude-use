import { describe, expect, it } from "vitest";

import { FAKE_CLAUDE_HOME, FAKE_HOME, FAKE_NOW_MS } from "../test-helpers";
import { planReconciliation, type FarmManifest, type ListingEntry, type ReconcileAction } from "./reconcile";

function manifest(overrides: Partial<FarmManifest> = {}): FarmManifest {
  return {
    version: 1,
    builtAtMs: FAKE_NOW_MS,
    identity: "testing",
    cwd: `${FAKE_HOME}/work`,
    claudeHome: FAKE_CLAUDE_HOME,
    materialised: [],
    links: [],
    ...overrides,
  };
}

function actionFor(actions: readonly ReconcileAction[], rel: string): ReconcileAction | undefined {
  return actions.find((action) => action.rel === rel);
}

describe("materialised directories", () => {
  const farmListing: ListingEntry[] = [
    { rel: "projects", kind: "dir" },
    { rel: "projects/-home-testuser-work-old", kind: "symlink" },
    { rel: "projects/-home-testuser-work-new", kind: "dir" },
    { rel: "projects/-home-testuser-work-new/session.jsonl", kind: "file", contentHash: "aaa" },
    { rel: "skills", kind: "symlink" },
  ];

  it("adopts a file Claude Code wrote into a materialised directory since the last resync", () => {
    const { actions } = planReconciliation({
      manifest: manifest({ materialised: ["projects"] }),
      farmListing,
      canonicalListing: [{ rel: "projects", kind: "dir" }],
    });
    expect(actionFor(actions, "projects/-home-testuser-work-new/session.jsonl")).toEqual({
      kind: "adopt",
      rel: "projects/-home-testuser-work-new/session.jsonl",
      reason: "absent-from-canonical",
    });
  });

  it("leaves the symlinks the previous resync placed alone", () => {
    const { actions } = planReconciliation({
      manifest: manifest({ materialised: ["projects"] }),
      farmListing,
      canonicalListing: [],
    });
    expect(actionFor(actions, "projects/-home-testuser-work-old")).toEqual({
      kind: "skip",
      rel: "projects/-home-testuser-work-old",
      reason: "is-symlink",
    });
    expect(actionFor(actions, "skills")).toEqual({ kind: "skip", rel: "skills", reason: "is-symlink" });
  });

  it("recognises a directory it materialised itself rather than treating it as new data", () => {
    const { actions } = planReconciliation({
      manifest: manifest({ materialised: ["projects"] }),
      farmListing,
      canonicalListing: [],
    });
    expect(actionFor(actions, "projects")).toEqual({ kind: "skip", rel: "projects", reason: "tracked-materialised-dir" });
  });

  it("emits no action for a real directory Claude Code created, only for its contents, so the pass stays idempotent", () => {
    const { actions } = planReconciliation({
      manifest: manifest({ materialised: ["projects"] }),
      farmListing,
      canonicalListing: [],
    });
    expect(actionFor(actions, "projects/-home-testuser-work-new")).toBeUndefined();
  });

  it("adopts an empty directory outright, since it has no contents to imply its existence", () => {
    const { actions } = planReconciliation({
      manifest: manifest({ materialised: ["projects"] }),
      farmListing: [
        { rel: "projects", kind: "dir" },
        { rel: "projects/-home-testuser-empty", kind: "dir" },
      ],
      canonicalListing: [],
    });
    expect(actionFor(actions, "projects/-home-testuser-empty")).toEqual({
      kind: "adopt",
      rel: "projects/-home-testuser-empty",
      reason: "absent-from-canonical",
    });
  });
});

describe("idempotency across an interrupted resync", () => {
  const farmListing: ListingEntry[] = [
    { rel: "projects", kind: "dir" },
    { rel: "projects/-home-testuser-work-new", kind: "dir" },
    { rel: "projects/-home-testuser-work-new/session.jsonl", kind: "file", contentHash: "aaa" },
  ];

  it("emits only skip(identical-content) on a second run against the same old farm", () => {
    const first = planReconciliation({
      manifest: manifest({ materialised: ["projects"] }),
      farmListing,
      canonicalListing: [{ rel: "projects", kind: "dir" }],
    });
    expect(first.actions.filter((action) => action.kind === "adopt")).toHaveLength(1);

    // The first run's adoption is applied to the canonical tree, then the process dies before the atomic swap, so the same old farm is read again on the next launch.
    const second = planReconciliation({
      manifest: manifest({ materialised: ["projects"] }),
      farmListing,
      canonicalListing: [
        { rel: "projects", kind: "dir" },
        { rel: "projects/-home-testuser-work-new", kind: "dir" },
        { rel: "projects/-home-testuser-work-new/session.jsonl", kind: "file", contentHash: "aaa" },
      ],
    });
    expect(second.actions.filter((action) => action.kind === "adopt")).toEqual([]);
    expect(second.actions.filter((action) => action.kind === "adopt-conflict")).toEqual([]);
    expect(actionFor(second.actions, "projects/-home-testuser-work-new/session.jsonl")).toEqual({
      kind: "skip",
      rel: "projects/-home-testuser-work-new/session.jsonl",
      reason: "identical-content",
    });
  });
});

describe("conflicts", () => {
  it("reports a farm file whose canonical counterpart exists with different content rather than overwriting either", () => {
    const { actions, diagnostics } = planReconciliation({
      manifest: manifest({ materialised: ["projects"] }),
      farmListing: [
        { rel: "projects", kind: "dir" },
        { rel: "projects/-a", kind: "dir" },
        { rel: "projects/-a/session.jsonl", kind: "file", contentHash: "farm-version" },
      ],
      canonicalListing: [{ rel: "projects/-a/session.jsonl", kind: "file", contentHash: "canonical-version" }],
    });
    expect(actionFor(actions, "projects/-a/session.jsonl")?.kind).toBe("adopt-conflict");
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("RECONCILE_CONFLICT");
  });
});

describe("conservative mode", () => {
  const farmListing: ListingEntry[] = [
    { rel: "projects", kind: "dir" },
    { rel: "projects/-a", kind: "dir" },
    { rel: "projects/-a/session.jsonl", kind: "file", contentHash: "aaa" },
    { rel: "skills", kind: "symlink" },
  ];

  it("treats every real directory as materialised when the manifest is missing, never silently doing nothing", () => {
    const result = planReconciliation({ farmListing, canonicalListing: [] });
    expect(result.conservative).toBe(true);
    expect(actionFor(result.actions, "projects/-a/session.jsonl")?.kind).toBe("adopt");
  });

  it("warns rather than crashing or no-opping", () => {
    const result = planReconciliation({ farmListing, canonicalListing: [] });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("FARM_MANIFEST_MISSING");
  });

  it("still leaves symlinks alone in conservative mode", () => {
    const result = planReconciliation({ farmListing, canonicalListing: [] });
    expect(actionFor(result.actions, "skills")?.kind).toBe("skip");
  });

  it("reports conservative as false when a manifest is present", () => {
    const result = planReconciliation({ manifest: manifest(), farmListing: [], canonicalListing: [] });
    expect(result.conservative).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });
});

describe("independence from the new resolved state", () => {
  it("takes no decisions and no farm plan as input at all, so it cannot be skipped for a directory about to be omitted", () => {
    // This is the whole reason the pass exists: the cases where the new plan drops or collapses a directory are exactly the cases where its contents would otherwise be discarded. Structurally, there is no parameter here that could ever cause the pass to be skipped for one.
    const { actions } = planReconciliation({
      manifest: manifest({ materialised: ["projects"] }),
      farmListing: [
        { rel: "projects", kind: "dir" },
        { rel: "projects/-a", kind: "dir" },
        { rel: "projects/-a/session.jsonl", kind: "file", contentHash: "aaa" },
      ],
      canonicalListing: [],
    });
    expect(actionFor(actions, "projects/-a/session.jsonl")?.kind).toBe("adopt");
  });
});

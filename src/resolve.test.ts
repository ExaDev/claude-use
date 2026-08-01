import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ConfigProfile } from "./config/schema";
import {
  planReconciliation,
  resolveDecisions,
  topLevelNames,
  type Decision,
  type ProfileLoader,
  type ResolvedState,
} from "./resolve";
import { DAY_MS, FAKE_CLAUDE_HOME, FAKE_HOME, FAKE_NOW_MS, makeFacts, shippedClassification } from "./test-helpers";
import type { CascadeInput, DirectoryLevelSources, EntryFacts } from "./resolve";

const home = FAKE_HOME;

function loader(profiles: Readonly<Record<string, ConfigProfile>>): ProfileLoader {
  return (name) => {
    const profile = profiles[name];
    return profile === undefined ? undefined : { name, profile };
  };
}

/** A realistic-shaped `~/.claude` fact manifest: knowledge, settings, history, runtime, and secrets side by side. */
function realisticFacts(overrides: Partial<Omit<EntryFacts, "entries">> = {}): EntryFacts {
  return makeFacts(
    {
      ".credentials.json": true,
      "backups/2026-01-01.json": true,
      "skills/commit/SKILL.md": true,
      "skills/pr-feedback/SKILL.md": true,
      "skills/private-notes/SKILL.md": true,
      "rules/index.md": true,
      "settings.json": true,
      "shell-snapshots/snap.sh": true,
      "projects/-home-testuser-work-clients-acme/session.jsonl": { mtimeMs: FAKE_NOW_MS - 2 * DAY_MS, sizeBytes: 100 },
      "projects/-home-testuser-work-clients-widget/session.jsonl": { mtimeMs: FAKE_NOW_MS - 200 * DAY_MS, sizeBytes: 100 },
    },
    overrides,
  );
}

function resolve(cascade: Omit<CascadeInput, "home">, facts: EntryFacts = realisticFacts()): ResolvedState {
  return resolveDecisions({
    facts,
    cascade: { home, ...cascade },
    classification: { defaults: shippedClassification },
  });
}

function shared(state: ResolvedState, rel: string): boolean | undefined {
  return state.decisions.get(rel)?.shared;
}

function decisionFor(state: ResolvedState, rel: string): Decision | undefined {
  return state.decisions.get(rel);
}

describe("shipped defaults with nothing configured", () => {
  it("shares knowledge and settings, and nothing else", () => {
    const state = resolve({ loadProfile: loader({}) });
    expect(shared(state, "skills")).toBe(true);
    expect(shared(state, "settings.json")).toBe(true);
    expect(shared(state, "projects")).toBe(false);
    expect(shared(state, "shell-snapshots")).toBe(false);
    expect(shared(state, ".credentials.json")).toBe(false);
  });
});

describe("cascade layering", () => {
  it("lets each layer override the last for the same category", () => {
    const state = resolve({
      globalConfig: { config: { categories: { history: true } }, filepath: "/cfg/config.json" },
      baseConfigProfile: "strict",
      loadProfile: loader({ strict: { categories: { history: false } } }),
    });
    expect(shared(state, "projects")).toBe(false);
    expect(decisionFor(state, "projects")?.via).toBe("category-override");
  });

  it("lets a path override beat its parent category, whichever layer set which", () => {
    const state = resolve({
      baseConfigProfile: "client-base",
      loadProfile: loader({
        "client-base": { categories: { knowledge: false }, entries: { "knowledge/skills/commit": true } },
      }),
    });
    expect(shared(state, "skills/commit")).toBe(true);
    expect(shared(state, "skills/private-notes")).toBe(false);
  });

  it("cannot silently undo a shallower layer's specific entry with a deeper layer's blanket category flip", () => {
    const levels: DirectoryLevelSources[] = [
      { dir: `${home}/work`, portable: { config: { entries: { "knowledge/skills/commit": true } }, filepath: "shallow" } },
      { dir: `${home}/work/acme`, portable: { config: { categories: { knowledge: false } }, filepath: "deep" } },
    ];
    const state = resolve({ loadProfile: loader({}), levels });
    expect(shared(state, "skills/commit")).toBe(true);
    expect(shared(state, "skills/private-notes")).toBe(false);
  });
});

describe("the two-phase merge algorithm", () => {
  it("resolves two layers setting the identical category to plain last-layer-wins", () => {
    const state = resolve({
      globalConfig: { config: { categories: { knowledge: true } }, filepath: "a" },
      baseConfigProfile: "b",
      loadProfile: loader({ b: { categories: { knowledge: false } } }),
    });
    expect(shared(state, "skills/private-notes")).toBe(false);
  });

  it("lets an exact literal beat a glob from the same layer", () => {
    const state = resolve({
      baseConfigProfile: "p",
      loadProfile: loader({ p: { categories: { knowledge: false }, entries: { "knowledge/skills/*": false, "knowledge/skills/commit": true } } }),
    });
    expect(shared(state, "skills/commit")).toBe(true);
  });

  it("resolves two globs from different layers to the later layer's value", () => {
    const levels: DirectoryLevelSources[] = [
      { dir: `${home}/work`, portable: { config: { entries: { "knowledge/skills/*": true } }, filepath: "earlier" } },
      { dir: `${home}/work/acme`, portable: { config: { entries: { "knowledge/skills/p*": false } }, filepath: "later" } },
    ];
    const state = resolve({ loadProfile: loader({}), levels });
    expect(shared(state, "skills/pr-feedback")).toBe(false);
    expect(shared(state, "skills/commit")).toBe(true);
  });

  it("resolves two globs from the same layer by longest literal prefix, then by source order", () => {
    const byPrefix = resolve({
      baseConfigProfile: "p",
      loadProfile: loader({ p: { entries: { "knowledge/skills/*": false, "knowledge/skills/pr-*": true } } }),
    });
    expect(shared(byPrefix, "skills/pr-feedback")).toBe(true);

    // Both of these have an empty literal prefix and two segments, so nothing but source order can separate them.
    const bySourceOrder = resolve({
      baseConfigProfile: "p",
      loadProfile: (name) =>
        name === "p"
          ? {
              name,
              profile: { entries: { "knowledge/*/pr-feedback": true, "knowledge/*s/pr-feedback": false } },
              entryOrder: ["knowledge/*/pr-feedback", "knowledge/*s/pr-feedback"],
            }
          : undefined,
    });
    expect(shared(bySourceOrder, "skills/pr-feedback")).toBe(false);

    const reversedSourceOrder = resolve({
      baseConfigProfile: "p",
      loadProfile: (name) =>
        name === "p"
          ? {
              name,
              profile: { entries: { "knowledge/*s/pr-feedback": false, "knowledge/*/pr-feedback": true } },
              entryOrder: ["knowledge/*s/pr-feedback", "knowledge/*/pr-feedback"],
            }
          : undefined,
    });
    expect(shared(reversedSourceOrder, "skills/pr-feedback")).toBe(true);
  });

  it("collapses two canonically-identical keys from different layers into one rule in phase one", () => {
    const levels: DirectoryLevelSources[] = [
      {
        dir: `${home}/work`,
        portable: { config: { entries: { "history/projects/~/work/clients/acme": true } }, filepath: "tilde" },
      },
      {
        dir: `${home}/work/acme`,
        portable: {
          config: { entries: { [`history/projects/${home}/work/clients/acme`]: false } },
          filepath: "absolute",
        },
      },
    ];
    const state = resolve({ loadProfile: loader({}), levels });
    const matching = [...state.flattened.rules.keys()].filter((pattern) => pattern.includes("clients-acme"));
    expect(matching).toEqual(["projects/-home-testuser-work-clients-acme"]);
    expect(shared(state, "projects/-home-testuser-work-clients-acme")).toBe(false);
  });
});

describe("the corrected comparator's trust property", () => {
  it("lets a personal directory rule tighten what an untrusted committed file opened, and never the reverse", () => {
    const levels: DirectoryLevelSources[] = [
      {
        dir: `${home}/work`,
        // A repo you just cloned opens one specific skill with an exact key.
        portable: { config: { entries: { "knowledge/skills/private-notes": true } }, filepath: "untrusted-repo" },
        // Your own pinned rule for the same path closes the whole subtree with a glob.
        rules: [{ rule: { path: `${home}/work`, entries: { "knowledge/skills/*": false } }, filepath: "personal-rule" }],
      },
    ];
    const state = resolve({ loadProfile: loader({}), levels });
    expect(shared(state, "skills/private-notes")).toBe(false);
    expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toContain("EXACT_ENTRY_OVERRIDDEN_BY_LATER_GLOB");
  });
});

describe("the secret category is un-overridable", () => {
  it("rejects a deliberate secret/ entries key with its own compile-time error", () => {
    const state = resolve({
      baseConfigProfile: "p",
      loadProfile: loader({ p: { entries: { "secret/.credentials.json": true } } }),
    });
    expect(shared(state, ".credentials.json")).toBe(false);
    const codes = state.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("SECRET_ENTRY_KEY");
    expect(codes).not.toContain("SECRET_PATH_NEUTRALISED");
  });

  it("neutralises a key under another prefix that incidentally reaches a secret path, with a distinct diagnostic", () => {
    const state = resolve({
      baseConfigProfile: "p",
      loadProfile: loader({ p: { entries: { "runtime/.credentials.json": true } } }),
    });
    expect(shared(state, ".credentials.json")).toBe(false);
    const codes = state.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("SECRET_PATH_NEUTRALISED");
    expect(codes).not.toContain("SECRET_ENTRY_KEY");
  });

  it("never symlinks ~/.claude/backups under any configuration whatsoever", () => {
    for (const cascade of [
      { loadProfile: loader({}), globalConfig: { config: { categories: { runtime: true, history: true, knowledge: true, settings: true } }, filepath: "c" } },
      { baseConfigProfile: "p", loadProfile: loader({ p: { entries: { "runtime/backups": true } } }) },
      { baseConfigProfile: "p", loadProfile: loader({ p: { entries: { "knowledge/backups/2026-01-01.json": true } } }) },
      { baseConfigProfile: "p", loadProfile: loader({ p: { entries: { "runtime/*": true } } }) },
    ]) {
      const state = resolve(cascade);
      expect(shared(state, "backups")).toBe(false);
      expect(shared(state, "backups/2026-01-01.json")).toBe(false);
      expect(state.farm.links.some((link) => link.rel.startsWith("backups"))).toBe(false);
      expect(state.farm.links.some((link) => link.rel === ".credentials.json")).toBe(false);
    }
  });
});

describe("~/.claude.json is structurally outside the resolver entirely", () => {
  it("never appears in the entry manifest, because it is a sibling of ~/.claude rather than a descendant", () => {
    const state = resolve({ loadProfile: loader({}) });
    expect(topLevelNames(realisticFacts())).not.toContain(".claude.json");
    expect(state.decisions.has(".claude.json")).toBe(false);
    // Every relative path the resolver ever sees is under `~/.claude`, so no key can even name the sibling file.
    for (const rel of state.decisions.keys()) {
      expect(rel.startsWith("..")).toBe(false);
    }
    for (const link of state.farm.links) {
      expect(link.target.startsWith(`${FAKE_CLAUDE_HOME}/`)).toBe(true);
    }
  });
});

describe("directory rules", () => {
  const profiles = loader({
    "work-default": { categories: { history: true } },
    "client-strict": { extends: ["work-default"], categories: { history: false, knowledge: false } },
  });

  it("folds nested paths shallowest-first, each level adding context", () => {
    const levels: DirectoryLevelSources[] = [
      { dir: `${home}/work`, rules: [{ rule: { path: `${home}/work`, configProfile: "work-default" }, filepath: "r1" }] },
      {
        dir: `${home}/work/clients`,
        rules: [{ rule: { path: `${home}/work/clients`, configProfile: "client-strict" }, filepath: "r2" }],
      },
    ];
    const state = resolve({ loadProfile: profiles, levels });
    expect(shared(state, "projects")).toBe(false);
    expect(shared(state, "skills/commit")).toBe(false);
  });

  it("composes a mid-tree profile in rather than swapping the base one out", () => {
    const levels: DirectoryLevelSources[] = [
      {
        dir: `${home}/work/clients/acme`,
        rules: [
          {
            rule: { path: `${home}/work/clients/acme`, configProfile: "client-strict", entries: { "knowledge/skills/commit": true } },
            filepath: "r",
          },
        ],
      },
    ];
    const state = resolve({ loadProfile: profiles, levels });
    expect(state.assembled.layers.map((layer) => layer.source)).toEqual(["work-default", "client-strict", "r"]);
    expect(shared(state, "skills/commit")).toBe(true);
    expect(shared(state, "skills/private-notes")).toBe(false);
  });

  it("lets a deeper rule narrow what a shallower one opened", () => {
    const levels: DirectoryLevelSources[] = [
      { dir: `${home}/oss`, rules: [{ rule: { path: `${home}/oss`, categories: { history: true } }, filepath: "a" }] },
      {
        dir: `${home}/oss/private-experiments`,
        rules: [{ rule: { path: `${home}/oss/private-experiments`, categories: { history: false } }, filepath: "b" }],
      },
    ];
    expect(shared(resolve({ loadProfile: profiles, levels }), "projects")).toBe(false);
    expect(shared(resolve({ loadProfile: profiles, levels: levels.slice(0, 1) }), "projects")).toBe(true);
  });
});

describe("portable .claude-use.json files", () => {
  it("folds committed files at different depths shallowest-to-deepest", () => {
    const levels: DirectoryLevelSources[] = [
      { dir: `${home}/work`, portable: { config: { categories: { history: true } }, filepath: "shallow" } },
      { dir: `${home}/work/repo`, portable: { config: { categories: { history: false } }, filepath: "deep" } },
    ];
    expect(shared(resolve({ loadProfile: loader({}), levels }), "projects")).toBe(false);
  });

  it("composes all three sources at one level most-personal-last", () => {
    const levels: DirectoryLevelSources[] = [
      {
        dir: `${home}/work/repo`,
        portable: { config: { categories: { history: true, knowledge: true } }, filepath: "committed" },
        rules: [{ rule: { path: `${home}/work/repo`, categories: { knowledge: false } }, filepath: "personal-rule" }],
        portableLocal: { config: { categories: { history: false } }, filepath: "local" },
      },
    ];
    const state = resolve({ loadProfile: loader({}), levels });
    expect(shared(state, "projects")).toBe(false);
    expect(shared(state, "skills/private-notes")).toBe(false);
    expect(state.assembled.layers.map((layer) => layer.source)).toEqual(["committed", "personal-rule", "local"]);
  });

  it("gives a teammate the repo's isolation-plus-shared-skills posture with no local configuration at all", () => {
    const levels: DirectoryLevelSources[] = [
      {
        dir: `${home}/work/repo`,
        portable: {
          config: {
            categories: { history: false },
            entries: { "knowledge/skills/commit": true, "knowledge/skills/pr-feedback": true },
          },
          filepath: `${home}/work/repo/.claude-use.json`,
        },
      },
    ];
    const state = resolve({ loadProfile: loader({}), levels });
    expect(shared(state, "projects")).toBe(false);
    expect(shared(state, "skills/commit")).toBe(true);
    expect(shared(state, "skills/pr-feedback")).toBe(true);
  });
});

describe("glob patterns against ~/.claude/projects/", () => {
  it("matches literal encoded directory names without ever decoding one back to a path", () => {
    const state = resolve({
      baseConfigProfile: "p",
      loadProfile: loader({ p: { entries: { "history/projects/~/work/clients/*": true } } }),
    });
    expect(shared(state, "projects/-home-testuser-work-clients-acme")).toBe(true);
    expect(shared(state, "projects/-home-testuser-work-clients-acme/session.jsonl")).toBe(true);
    expect(shared(state, "projects/-home-testuser-work-clients-widget")).toBe(true);
  });

  it("shares only the matching project directories, not the whole history category", () => {
    const facts = makeFacts({
      "projects/-home-testuser-work-clients-acme/session.jsonl": true,
      "projects/-home-testuser-personal-blog/session.jsonl": true,
      "todos/a.json": true,
    });
    const state = resolve(
      { baseConfigProfile: "p", loadProfile: loader({ p: { entries: { "history/projects/~/work/clients/*": true } } }) },
      facts,
    );
    expect(shared(state, "projects/-home-testuser-work-clients-acme")).toBe(true);
    expect(shared(state, "projects/-home-testuser-personal-blog")).toBe(false);
    expect(shared(state, "todos")).toBe(false);
  });
});

describe("extends chains", () => {
  it("resolves a multi-level chain with each layer stating only what differs", () => {
    const state = resolve({
      baseConfigProfile: "client-acme",
      loadProfile: loader({
        base: { categories: { history: true, knowledge: true } },
        work: { extends: ["base"], categories: { history: false } },
        "client-acme": { extends: ["work"], entries: { "knowledge/skills/commit": true } },
      }),
    });
    expect(shared(state, "projects")).toBe(false);
    expect(shared(state, "skills/commit")).toBe(true);
    expect(state.assembled.layers.map((layer) => layer.source)).toEqual(["base", "work", "client-acme"]);
  });

  it("resolves a diamond so the intermediate override survives, with no cycle diagnostics", () => {
    const state = resolve({
      baseConfigProfile: "c",
      loadProfile: loader({
        base: { categories: { history: true } },
        a: { extends: ["base"], categories: { history: false } },
        b: { extends: ["base"] },
        c: { extends: ["a", "b"] },
      }),
    });
    expect(state.assembled.layers.map((layer) => layer.source)).toEqual(["base", "a", "b", "c"]);
    expect(shared(state, "projects")).toBe(false);
    expect(state.diagnostics.filter((diagnostic) => diagnostic.code === "EXTENDS_CYCLE")).toEqual([]);
  });

  it("lets the later of two directly-extended profiles win where they disagree", () => {
    const state = resolve({
      baseConfigProfile: "both",
      loadProfile: loader({
        left: { categories: { history: true } },
        right: { categories: { history: false } },
        both: { extends: ["left", "right"] },
      }),
    });
    expect(shared(state, "projects")).toBe(false);
  });

  it("detects and rejects a circular extends definition instead of looping", () => {
    const state = resolve({
      baseConfigProfile: "a",
      loadProfile: loader({ a: { extends: ["b"] }, b: { extends: ["a"] } }),
    });
    expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toContain("EXTENDS_CYCLE");
  });
});

describe("one identity, two configuration profiles", () => {
  const profiles = loader({
    "client-base": {
      categories: { knowledge: false, history: false },
      entries: { "knowledge/skills/commit": true, "knowledge/skills/pr-feedback": true, "knowledge/rules": true },
    },
    "client-acme": { extends: ["client-base"], entries: { "history/projects/~/work/clients/acme": true } },
    "client-widget": { extends: ["client-base"], entries: { "history/projects/~/work/clients/widget": true } },
  });

  it("resolves to different states under two profiles with no leakage between them", () => {
    const acme = resolve({ baseConfigProfile: "client-acme", loadProfile: profiles });
    const widget = resolve({ baseConfigProfile: "client-widget", loadProfile: profiles });

    expect(shared(acme, "projects/-home-testuser-work-clients-acme")).toBe(true);
    expect(shared(acme, "projects/-home-testuser-work-clients-widget")).toBe(false);

    expect(shared(widget, "projects/-home-testuser-work-clients-widget")).toBe(true);
    expect(shared(widget, "projects/-home-testuser-work-clients-acme")).toBe(false);

    // The shared knowledge stays available to both, and the private skill to neither.
    for (const state of [acme, widget]) {
      expect(shared(state, "skills/commit")).toBe(true);
      expect(shared(state, "skills/pr-feedback")).toBe(true);
      expect(shared(state, "rules")).toBe(true);
      expect(shared(state, "skills/private-notes")).toBe(false);
    }
  });
});

describe("conditional entries end to end", () => {
  it("shares recent history and excludes stale history under one glob, with injected mtimes", () => {
    const state = resolve({
      baseConfigProfile: "p",
      loadProfile: loader({ p: { entries: { "history/projects/~/work/clients/*": { value: true, when: { newerThan: "90d" } } } } }),
    });
    expect(shared(state, "projects/-home-testuser-work-clients-acme")).toBe(true);
    expect(shared(state, "projects/-home-testuser-work-clients-widget")).toBe(false);
  });

  it("applies a branch condition only on a matching branch, from the injected branch rather than a real repository", () => {
    const rule = { entries: { "knowledge/skills/private-notes": { value: true, when: { branch: "client/*" } } } };
    const onBranch = resolve({ baseConfigProfile: "p", loadProfile: loader({ p: rule }) }, realisticFacts({ branch: "client/acme" }));
    const offBranch = resolve({ baseConfigProfile: "p", loadProfile: loader({ p: rule }) }, realisticFacts({ branch: "main" }));
    const detached = resolve(
      { baseConfigProfile: "p", loadProfile: loader({ p: rule }) },
      realisticFacts({ branch: "client/acme", branchDetached: true }),
    );
    expect(shared(onBranch, "skills/private-notes")).toBe(true);
    expect(shared(offBranch, "skills/private-notes")).toBe(true);
    expect(decisionFor(offBranch, "skills/private-notes")?.via).toBe("category-default");
    expect(decisionFor(detached, "skills/private-notes")?.via).toBe("category-default");
  });

  it("applies an env condition only when the injected environment snapshot carries the right value", () => {
    const rule = { categories: { knowledge: false }, entries: { "knowledge/skills/commit": { value: true, when: { env: { CLAUDE_USE_MODE: "open" } } } } };
    const on = resolve({ baseConfigProfile: "p", loadProfile: loader({ p: rule }) }, realisticFacts({ env: { CLAUDE_USE_MODE: "open" } }));
    const off = resolve({ baseConfigProfile: "p", loadProfile: loader({ p: rule }) }, realisticFacts({ env: {} }));
    expect(shared(on, "skills/commit")).toBe(true);
    expect(shared(off, "skills/commit")).toBe(false);
  });

  it("always materialises a conditionally-matched subtree rather than symlinking it", () => {
    const state = resolve({
      baseConfigProfile: "p",
      loadProfile: loader({ p: { entries: { "history/projects/~/work/clients/*": { value: true, when: { newerThan: "90d" } } } } }),
    });
    const projects = state.farm.entries.find((entry) => entry.rel === "projects");
    expect(projects?.kind).toBe("materialise");
    expect(state.farm.materialised).toContain("projects");
  });
});

describe("launch flags resolve through the same cascade", () => {
  it("defaults both flags off and lets a later layer set each independently", () => {
    expect(resolve({ loadProfile: loader({}) }).flattened.launch).toEqual({});
    const state = resolve({
      baseConfigProfile: "p",
      loadProfile: loader({ p: { launch: { skipPermissions: true } } }),
      cliOverride: { launch: { remoteControl: true } },
    });
    expect(state.flattened.launch).toEqual({ skipPermissions: true, remoteControl: true });
  });
});

describe("the whole pipeline against a materialised farm", () => {
  it("reconciles new data out of a materialised directory even when the new plan omits that directory entirely", () => {
    // The previous resync materialised `projects` for a conditional rule; Claude Code then wrote a new session into it. The new configuration closes history wholesale, so the new plan omits `projects` — which is precisely the case where that session would be lost without a write-through pass that runs independently of the new decisions.
    const state = resolve({
      baseConfigProfile: "p",
      loadProfile: loader({ p: { categories: { history: false } } }),
    });
    expect(state.farm.entries.find((entry) => entry.rel === "projects")?.kind).toBe("omit");

    const reconciliation = planReconciliation({
      manifest: {
        version: 1,
        builtAtMs: FAKE_NOW_MS - DAY_MS,
        identity: "testing",
        cwd: `${home}/work`,
        claudeHome: FAKE_CLAUDE_HOME,
        materialised: ["projects"],
        links: [],
      },
      farmListing: [
        { rel: "projects", kind: "dir" },
        { rel: "projects/-home-testuser-work-clients-brand-new", kind: "dir" },
        { rel: "projects/-home-testuser-work-clients-brand-new/session.jsonl", kind: "file", contentHash: "new" },
      ],
      canonicalListing: [{ rel: "projects", kind: "dir" }],
    });
    expect(
      reconciliation.actions.find(
        (action) => action.rel === "projects/-home-testuser-work-clients-brand-new/session.jsonl",
      )?.kind,
    ).toBe("adopt");
  });
});

describe("module boundary", () => {
  it("is the only way into the resolver — nothing outside src/resolve/ imports its internals directly", () => {
    // The resolver's internal split into match/flatten/decide/extends/walk/plan/reconcile is an implementation detail. Enforcing that structurally here, rather than trusting convention, is what keeps it free to change.
    const sourceRoot = path.join(__dirname);
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) {
          continue;
        }
        const relative = path.relative(sourceRoot, full);
        if (relative.startsWith("resolve/") || relative === "resolve.ts" || relative === "resolve.test.ts") {
          continue;
        }
        if (/from\s+"[^"]*\bresolve\/[^"]+"/.test(fs.readFileSync(full, "utf8"))) {
          offenders.push(relative);
        }
      }
    };
    walk(sourceRoot);

    expect(offenders).toEqual([]);
  });
});

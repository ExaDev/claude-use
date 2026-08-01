import { describe, expect, it } from "vitest";

import type { ConfigProfile } from "../config/schema";
import { lineariseProfile, profileLayers, type ProfileLoader } from "./extends";

function loader(profiles: Readonly<Record<string, ConfigProfile>>): ProfileLoader {
  return (name: string) => {
    const profile = profiles[name];
    return profile === undefined ? undefined : { name, profile };
  };
}

describe("lineariseProfile", () => {
  it("emits a linear chain base-first", () => {
    const load = loader({
      base: {},
      work: { extends: ["base"] },
      "client-acme": { extends: ["work"] },
    });
    expect(lineariseProfile("client-acme", load).order).toEqual(["base", "work", "client-acme"]);
  });

  it("emits a single profile with no extends as itself", () => {
    expect(lineariseProfile("solo", loader({ solo: {} })).order).toEqual(["solo"]);
  });

  it("emits multiple extends in the order they were written, so the later one wins", () => {
    const load = loader({ base: {}, work: {}, both: { extends: ["base", "work"] } });
    expect(lineariseProfile("both", load).order).toEqual(["base", "work", "both"]);
  });
});

describe("diamond extends", () => {
  // c extends [a, b]; both a and b extend base; a deliberately overrides what base set.
  const diamond = loader({
    base: { categories: { history: true, knowledge: true } },
    a: { extends: ["base"], categories: { history: false } },
    b: { extends: ["base"] },
    c: { extends: ["a", "b"] },
  });

  it("emits the shared base exactly once, post-order, rather than re-emitting it per branch", () => {
    expect(lineariseProfile("c", diamond).order).toEqual(["base", "a", "b", "c"]);
  });

  it("never re-applies the shared base's values on top of an intermediate profile's own override", () => {
    const order = lineariseProfile("c", diamond).order;
    const firstBase = order.indexOf("base");
    expect(order.lastIndexOf("base")).toBe(firstBase);
    // If `base` were emitted a second time after `a`, `a`'s `history: false` would be silently undone by base's `history: true` — a wrong answer with no error anywhere.
    expect(order.slice(order.indexOf("a"))).not.toContain("base");
  });

  it("raises zero cycle diagnostics for a legitimate diamond", () => {
    const diagnostics = lineariseProfile("c", diamond).diagnostics;
    expect(diagnostics.filter((diagnostic) => diagnostic.code === "EXTENDS_CYCLE")).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("resolves a diamond's layers so the intermediate override survives into the flattened result", () => {
    const { layers } = profileLayers("c", diamond, 0);
    expect(layers.map((layer) => layer.source)).toEqual(["base", "a", "b", "c"]);
    const historyValues = layers.map((layer) => layer.categories?.history);
    expect(historyValues).toEqual([true, false, undefined, undefined]);
  });
});

describe("cycle detection", () => {
  it("detects a direct two-profile cycle without looping or overflowing the stack", () => {
    const load = loader({ a: { extends: ["b"] }, b: { extends: ["a"] } });
    const result = lineariseProfile("a", load);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("EXTENDS_CYCLE");
    expect(result.order).toEqual(["b", "a"]);
  });

  it("detects a self-referential profile", () => {
    const result = lineariseProfile("a", loader({ a: { extends: ["a"] } }));
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["EXTENDS_CYCLE"]);
    expect(result.order).toEqual(["a"]);
  });

  it("detects a longer cycle and names the whole path in the diagnostic", () => {
    const load = loader({ a: { extends: ["b"] }, b: { extends: ["c"] }, c: { extends: ["a"] } });
    const result = lineariseProfile("a", load);
    const cycle = result.diagnostics.find((diagnostic) => diagnostic.code === "EXTENDS_CYCLE");
    expect(cycle?.message).toContain("a -> b -> c -> a");
  });

  it("still emits every profile exactly once when a cycle is broken", () => {
    const load = loader({ a: { extends: ["b"] }, b: { extends: ["c"] }, c: { extends: ["a"] } });
    const order = lineariseProfile("a", load).order;
    expect(new Set(order).size).toBe(order.length);
  });
});

describe("missing profiles", () => {
  it("reports a missing profile rather than silently skipping it", () => {
    const result = lineariseProfile("work", loader({ work: { extends: ["nonexistent"] } }));
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["MISSING_PROFILE"]);
    expect(result.order).toEqual(["work"]);
  });

  it("reports a missing root profile", () => {
    const result = lineariseProfile("nothing", loader({}));
    expect(result.order).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("MISSING_PROFILE");
  });

  it("reports each missing profile only once even when several branches reference it", () => {
    const load = loader({ a: { extends: ["gone"] }, b: { extends: ["gone"] }, c: { extends: ["a", "b"] } });
    const result = lineariseProfile("c", load);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "MISSING_PROFILE")).toHaveLength(1);
  });
});

describe("profileLayers", () => {
  it("assigns strictly ascending layer ids starting from the given index", () => {
    const load = loader({ base: {}, work: { extends: ["base"] } });
    const { layers, nextId } = profileLayers("work", load, 5);
    expect(layers.map((layer) => layer.id)).toEqual([5, 6]);
    expect(nextId).toBe(7);
  });

  it("carries each profile's categories, entries, entry order, and launch flags onto its layer", () => {
    const load: ProfileLoader = (name) =>
      name === "work"
        ? {
            name,
            profile: {
              categories: { history: true },
              entries: { "knowledge/skills/commit": true },
              launch: { skipPermissions: true },
            },
            entryOrder: ["knowledge/skills/commit"],
            filepath: "/cfg/work.json",
          }
        : undefined;
    const [layer] = profileLayers("work", load, 0).layers;
    expect(layer?.source).toBe("/cfg/work.json");
    expect(layer?.categories).toEqual({ history: true });
    expect(layer?.entryOrder).toEqual(["knowledge/skills/commit"]);
    expect(layer?.launch).toEqual({ skipPermissions: true });
  });
});

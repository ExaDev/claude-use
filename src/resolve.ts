/**
 * The public face of the cascade resolver.
 *
 * Nothing outside `src/resolve/` imports the internals directly — this facade is the whole surface. That keeps the resolver's own module boundaries free to change without a rewrite elsewhere, and it keeps the one property that matters about this code visible in one place: every function reachable from here is pure in the sense that matters, taking filesystem, git, clock, and environment facts as injected parameters rather than reading them. That is what lets the entire cascade be tested with fake mtimes, a fake branch, and a fake environment, without touching a real `~/.claude` or a real `~/.claude-use`.
 */

import { classifyEntries, type ClassifyResult } from "./config/classify";
import type { CategoryClassification, CategoryClassificationOverlay } from "./config/schema";
import { resolveAll, type ResolveAllResult } from "./resolve/decide";
import { flattenLayers } from "./resolve/flatten";
import { planFarm, type FarmPlan } from "./resolve/plan";
import { assembleCascade, type AssembledCascade, type CascadeInput } from "./resolve/walk";
import type { Diagnostic, EntryFacts, FlattenedCascade } from "./resolve/types";

export * from "./resolve/types";
export {
  canonicaliseEntryKey,
  compareSpecificity,
  compileMatcher,
  EntryKeyError,
  isExactPattern,
  literalPrefixOf,
  normaliseRelative,
  patternCouldReachUnder,
  PROJECTS_PREFIX,
} from "./resolve/match";
export {
  detectEncodingAmbiguity,
  encodeProjectPath,
  encodeProjectPattern,
  expandHome,
  splitOnWildcards,
  UnrootedProjectPathError,
  type EncodingAmbiguity,
  type EncodingAmbiguityReason,
} from "./resolve/projects";
export { evaluateWhen, isDuration, isVacuousWhen, matchBranch, parseDuration, type ConditionContext, type WhenEvaluation } from "./resolve/conditions";
export { flattenLayers, matchingRules } from "./resolve/flatten";
export { dedupeDiagnostics, resolveAll, resolveEntry, selectRule, type DecideParams, type ResolveAllResult, type RuleSelection } from "./resolve/decide";
export { lineariseProfile, profileLayers, type LinearisedProfiles, type ProfileLoader, type ProfileSource } from "./resolve/extends";
export {
  assembleCascade,
  walkDirectoryAncestors,
  type AssembledCascade,
  type CascadeInput,
  type DirectoryLevelSources,
  type ReadablePredicate,
  type WalkOptions,
} from "./resolve/walk";
export { buildChildIndex, planFarm, type FarmPlan, type FarmPlanEntry, type MaterialiseReason, type PlanFarmParams } from "./resolve/plan";
export {
  planReconciliation,
  type FarmManifest,
  type ListingEntry,
  type ReconcileAction,
  type ReconciliationPlan,
  type ReconcileParams,
  type SkipReason,
} from "./resolve/reconcile";

/** Everything one launch needs resolved, in one call. */
export interface ResolveDecisionsInput {
  readonly facts: EntryFacts;
  readonly cascade: CascadeInput;
  readonly classification: { readonly defaults: CategoryClassification; readonly overlay?: CategoryClassificationOverlay };
}

/** The fully resolved state of one launch: the layers that composed it, every entry's decision, the farm layout, and everything worth reporting. */
export interface ResolvedState {
  readonly assembled: AssembledCascade;
  readonly flattened: FlattenedCascade;
  readonly classification: ClassifyResult;
  readonly decisions: ResolveAllResult["decisions"];
  readonly farm: FarmPlan;
  readonly diagnostics: readonly Diagnostic[];
}

/** The top-level `~/.claude` entry names present in a fact manifest, in sorted order. */
export function topLevelNames(facts: EntryFacts): string[] {
  const names = new Set<string>();
  for (const rel of facts.entries.keys()) {
    const head = rel.split("/")[0];
    if (head !== undefined && head !== "") {
      names.add(head);
    }
  }
  return [...names].sort();
}

/**
 * Runs the whole pipeline for one launch: assemble the ordered layer sequence, flatten it, classify the real `~/.claude` entries, decide every path, and plan the resulting farm.
 */
export function resolveDecisions(input: ResolveDecisionsInput): ResolvedState {
  const assembled = assembleCascade(input.cascade);
  const flattened = flattenLayers(assembled.layers, { home: input.facts.home });
  const classification = classifyEntries(topLevelNames(input.facts), {
    defaults: input.classification.defaults,
    ...(input.classification.overlay === undefined ? {} : { overlay: input.classification.overlay }),
  });
  const resolved = resolveAll({
    flattened,
    facts: input.facts,
    classification: classification.classification,
  });
  const farm = planFarm({ facts: input.facts, decisions: resolved.decisions, flattened });

  return {
    assembled,
    flattened,
    classification,
    decisions: resolved.decisions,
    farm,
    diagnostics: [...assembled.diagnostics, ...resolved.diagnostics],
  };
}

import { z } from "zod";

/**
 * Every category a `~/.claude` entry can be classified into. `secret` is deliberately part of this list — it is a real classification the resolver acts on — but it is NOT part of `CategoryMapSchema`'s shape, because no configuration layer may ever toggle it. See OVERRIDABLE_CATEGORIES.
 */
export const CATEGORY_NAMES = ["secret", "runtime", "history", "knowledge", "settings"] as const;
export type CategoryName = (typeof CATEGORY_NAMES)[number];

/** The four categories a configuration layer is allowed to toggle. `secret` is absent by design. */
export const OVERRIDABLE_CATEGORIES = ["runtime", "history", "knowledge", "settings"] as const;
export type OverridableCategory = (typeof OVERRIDABLE_CATEGORIES)[number];

/** True when `name` is one of the four categories a configuration layer may toggle. */
export function isOverridableCategory(name: string): name is OverridableCategory {
  return OVERRIDABLE_CATEGORIES.some((category) => category === name);
}

/** True when `name` is any of the five classification categories, including `secret`. */
export function isCategoryName(name: string): name is CategoryName {
  return CATEGORY_NAMES.some((category) => category === name);
}

/**
 * The category toggle map. A closed, strict object over the four overridable categories only: `secret` is omitted from the shape entirely, so `{ "categories": { "secret": true } }` is rejected at parse time rather than relying solely on the resolver's runtime floor check. The closed shape is also what lets the published JSON Schema offer real key-name autocomplete, which an open record type cannot.
 */
export const CategoryMapSchema = z.strictObject({
  runtime: z.boolean().optional(),
  history: z.boolean().optional(),
  knowledge: z.boolean().optional(),
  settings: z.boolean().optional(),
});
export type CategoryMap = z.infer<typeof CategoryMapSchema>;

/** A duration literal: a positive integer count followed by a unit. Used by `newerThan`/`olderThan`. */
export const DURATION_RE = /^(?:0|[1-9][0-9]*)(?:ms|s|m|h|d|w)$/;
export const DurationSchema = z.string().regex(DURATION_RE);

/**
 * A conditional guard on an entries value or a whole directory rule. Every field present within one `when` object must hold (AND logic). An empty object is vacuously true — `claude-use check` warns about it, it is never an error.
 */
export const WhenSchema = z.strictObject({
  newerThan: DurationSchema.optional(),
  olderThan: DurationSchema.optional(),
  maxSizeBytes: z.int().positive().optional(),
  branch: z.string().min(1).optional(),
  env: z.record(z.string().min(1), z.string()).optional(),
});
export type WhenCondition = z.infer<typeof WhenSchema>;

/** An entries value: a flat boolean, or a boolean guarded by a `when` condition. */
export const EntryValueSchema = z.union([
  z.boolean(),
  z.strictObject({ value: z.boolean(), when: WhenSchema }),
]);
export type EntryValue = z.infer<typeof EntryValueSchema>;

/**
 * Every entries key is `<category>/<real-relative-path>`, always — never a bare path. The prefix is what makes a key unambiguous when two categories happen to share a top-level name, and it is what lets the resolver cross-check a key's *declared* category against the *real* classification of the path it names, catching an entry that tries to launder a secret path through a `runtime/...` key.
 */
export const ENTRY_KEY_RE = /^(?:secret|runtime|history|knowledge|settings)\/(?!\/)\S(?:.*\S)?$/;
export const EntriesSchema = z.record(z.string().regex(ENTRY_KEY_RE), EntryValueSchema);
export type Entries = z.infer<typeof EntriesSchema>;

/** Launch flags, resolved through the same cascade as categories and entries. */
export const LaunchSchema = z.strictObject({
  skipPermissions: z.boolean().optional(),
  remoteControl: z.boolean().optional(),
});
export type LaunchFlags = z.infer<typeof LaunchSchema>;

/**
 * A named, reusable configuration profile at `~/.claude-use/config-profiles/<name>.json`.
 *
 * `extends` is a flat array of other profiles' *names*, deliberately not a self-referential `z.lazy()` schema: nothing in this shape points back at a profile object, so each file validates in isolation and the extends graph is walked at resolve time. That also means Zod cannot detect a circular `extends` definition — the walker in `src/resolve/extends.ts` carries its own cycle guard.
 */
export const ConfigProfileSchema = z.strictObject({
  $schema: z.string().optional(),
  description: z.string().optional(),
  extends: z.array(z.string().min(1)).optional(),
  categories: CategoryMapSchema.optional(),
  entries: EntriesSchema.optional(),
  launch: LaunchSchema.optional(),
});
export type ConfigProfile = z.infer<typeof ConfigProfileSchema>;

/** One directory rule in `~/.claude-use/directory-rules.json`, scoped to an explicit absolute (or `~`-rooted) path. */
export const DirectoryRuleSchema = ConfigProfileSchema.omit({ description: true }).extend({
  path: z.string().min(1),
  configProfile: z.string().min(1).optional(),
  identity: z.string().min(1).optional(),
  when: WhenSchema.optional(),
});
export type DirectoryRule = z.infer<typeof DirectoryRuleSchema>;

/** The `~/.claude-use/directory-rules.json` file. */
export const DirectoryRulesSchema = z.strictObject({
  $schema: z.string().optional(),
  rules: z.array(DirectoryRuleSchema),
});
export type DirectoryRules = z.infer<typeof DirectoryRulesSchema>;

/**
 * A committed `.claude-use.json` (or its gitignored `.claude-use.local.json` sibling). Structurally a directory rule without the `path` field: its scope is implicit — wherever the file lives, and everything below it — which is exactly what makes it portable across clone locations.
 */
export const PortableConfigSchema = ConfigProfileSchema.omit({ description: true }).extend({
  configProfile: z.string().min(1).optional(),
  identity: z.string().min(1).optional(),
  when: WhenSchema.optional(),
});
export type PortableConfig = z.infer<typeof PortableConfigSchema>;

/** The user-global `~/.claude-use/config.json`. */
export const GlobalConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  defaultConfigProfile: z.string().min(1).optional(),
  walkUpLimit: z.string().min(1).optional(),
  categories: CategoryMapSchema.optional(),
  entries: EntriesSchema.optional(),
  launch: LaunchSchema.optional(),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

/** An identity's own `identity.json`. */
export const IdentitySchema = z.strictObject({
  $schema: z.string().optional(),
  name: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  defaultConfigProfile: z.string().min(1).optional(),
  allowAmbientCredential: z.boolean().default(false),
});
export type Identity = z.infer<typeof IdentitySchema>;

/**
 * The OTHER "categories" concept, and a different shape from CategoryMapSchema entirely: this maps each category name to the list of literal names and globs whose top-level `~/.claude` entries belong to it. CategoryMapSchema says *whether* a category is shared; this says *which entries are in* a category. Do not conflate them.
 */
export const CategoryClassificationSchema = z.strictObject({
  $schema: z.string().optional(),
  secret: z.array(z.string().min(1)),
  runtime: z.array(z.string().min(1)),
  history: z.array(z.string().min(1)),
  knowledge: z.array(z.string().min(1)),
  settings: z.array(z.string().min(1)),
});
export type CategoryClassification = z.infer<typeof CategoryClassificationSchema>;

/** The gitignored `~/.claude-use/categories.local.json` overlay: any subset of the classification lists, answering "what category is this new entry?" without editing the shipped default map. */
export const CategoryClassificationOverlaySchema = z.strictObject({
  $schema: z.string().optional(),
  secret: z.array(z.string().min(1)).optional(),
  runtime: z.array(z.string().min(1)).optional(),
  history: z.array(z.string().min(1)).optional(),
  knowledge: z.array(z.string().min(1)).optional(),
  settings: z.array(z.string().min(1)).optional(),
});
export type CategoryClassificationOverlay = z.infer<typeof CategoryClassificationOverlaySchema>;

/**
 * Whether a category is shared when no configuration layer says otherwise. This is the final fallback beneath every layer of the cascade, matching the README's category table: only `knowledge` and `settings` are shared out of the box, and `secret` can never be.
 */
export const SHIPPED_CATEGORY_DEFAULTS: Readonly<Record<CategoryName, boolean>> = Object.freeze({
  secret: false,
  runtime: false,
  history: false,
  knowledge: true,
  settings: true,
});

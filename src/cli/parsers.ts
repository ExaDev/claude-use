/**
 * Small, thoroughly-tested parsing helpers for the repeatable, comma-separated CLI flag shapes used across `claude-use profile set --category ...` and `claude-use profile set --entry ...` (e.g. `--category history=true,knowledge=false`).
 *
 * Deliberately out of scope: a value containing an escaped comma (e.g. an entry path with a literal comma in it). Splitting on a bare comma is the whole contract — no escaping syntax is defined or recognised.
 */

/** Splits `input` on top-level (unescaped) commas. An empty string yields an empty array, not `[""]`. */
export function splitTopLevelCommas(input: string): readonly string[] {
  if (input === "") {
    return [];
  }
  return input.split(",");
}

/** One `<key>=<value>` pair, as parsed by `parsePair`. */
export interface ParsedPair {
  readonly key: string;
  readonly value: string;
}

/**
 * Splits `input` on its *first* `=` into a key and a value. The value may itself contain further `=` characters (they stay part of the value); only the first `=` is treated as the separator.
 *
 * Throws when there is no `=` at all, or when the key half is empty (`=true`, or a leading `=`).
 */
export function parsePair(input: string): ParsedPair {
  const eqIndex = input.indexOf("=");
  if (eqIndex === -1) {
    throw new Error(`Expected "<key>=<value>", got "${input}" (no "=" found)`);
  }
  const key = input.slice(0, eqIndex);
  const value = input.slice(eqIndex + 1);
  if (key === "") {
    throw new Error(`Expected a non-empty key before "=" in "${input}"`);
  }
  return { key, value };
}

/** Parses `input` strictly as `"true"` or `"false"` — no case-insensitivity, no `1`/`0`, no truthy/falsy coercion. */
export function parseBoolStrict(input: string): boolean {
  if (input === "true") {
    return true;
  }
  if (input === "false") {
    return false;
  }
  throw new Error(`Expected "true" or "false", got "${input}"`);
}

/**
 * Parses a comma-separated list of `<key>=<bool>` pairs into a plain object, e.g. `"history=true,knowledge=false"` -> `{ history: true, knowledge: false }`.
 *
 * An empty string parses to `{}`. A key repeated within the same list is not an error — the later occurrence in the string wins, matching how a plain object literal with a repeated key behaves.
 */
export function parseBoolPairList(input: string): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const piece of splitTopLevelCommas(input)) {
    const { key, value } = parsePair(piece);
    result[key] = parseBoolStrict(value);
  }
  return result;
}

/**
 * Commander repeatable-option collector for a `--flag "a=true,b=false"`-shaped option: parses `value` and merges it over `previous`, so `--category history=true --category knowledge=false` (two separate invocations) accumulates into one object, later invocations winning on key collision — the same convention Commander's own repeatable-option examples use for arrays, applied to a merged object instead.
 */
export function collectBoolPairs(value: string, previous: Record<string, boolean> = {}): Record<string, boolean> {
  return { ...previous, ...parseBoolPairList(value) };
}

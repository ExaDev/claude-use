import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

import { noPointlessReassignmentRule } from "./eslint-rules/no-pointless-reassignment";

// Bans re-export syntax (`export * from "..."`, `export { x } from "..."`) everywhere, no exceptions -- every consumer imports directly from the real source rather than through an intermediate re-export or barrel file.
const EXPORT_ALL_SELECTOR = "ExportAllDeclaration";
const EXPORT_NAMED_SELECTOR = "ExportNamedDeclaration[source]";
const RE_EXPORT_ALL_MESSAGE = "Re-exporting all exports is not allowed - import directly from the source.";
const RE_EXPORT_NAMED_MESSAGE = "Re-exporting is not allowed - import directly from the source.";

export default tseslint.config(
  { ignores: ["dist", "coverage", "node_modules"] },
  {
    languageOptions: {
      // stamp-schema-ids.mjs is a plain utility script, never part of the type-checked TS project -- fall back to non-type-aware parsing for it instead of pulling it into tsconfig's include just to satisfy the type-aware project service.
      parserOptions: { projectService: { allowDefaultProject: ["scripts/stamp-schema-ids.mjs"] }, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    // stamp-schema-ids.mjs has no real tsconfig-backed type information (see the allowDefaultProject note above) -- type-aware rules against it just fire noise (every Node built-in call reads as "unsafe" with no real type behind it), so drop the type-checked rule sets for it specifically rather than fighting that.
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  { linterOptions: { noInlineConfig: true } },
  {
    plugins: { local: { rules: { "no-pointless-reassignment": noPointlessReassignmentRule } } },
    rules: {
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "local/no-pointless-reassignment": "error",
      "no-restricted-syntax": [
        "error",
        { selector: EXPORT_ALL_SELECTOR, message: RE_EXPORT_ALL_MESSAGE },
        { selector: EXPORT_NAMED_SELECTOR, message: RE_EXPORT_NAMED_MESSAGE },
      ],
    },
  },
);

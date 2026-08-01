import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

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
    rules: {
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
    },
  },
);

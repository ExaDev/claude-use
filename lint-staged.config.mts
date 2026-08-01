import type { Configuration } from "lint-staged";

/** ESLint --fix is the project's only formatter (no Prettier). Kept fast on pre-commit; the full test suite runs on pre-push (.husky/pre-push). `.mts`, not `.ts`: lint-staged loads its config with a bare `import()`, and this package is `"type": "commonjs"`, so a plain `.ts` file would be loaded as CommonJS and its `export default` would fail to parse — `.mts` is unconditionally ESM regardless of the package's own `type` field. */
const config: Configuration = {
  "*.{ts,tsx}": "eslint --fix",
};

export default config;

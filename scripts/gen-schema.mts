import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

/**
 * Bundles `scripts/gen-schema-core.ts` (which imports `src/config/schema.ts` and `zod`) with esbuild into a single ESM file, then runs it.
 *
 * This indirection exists because `package.json` declares `"type": "commonjs"`, so a bare `.ts` file importing `src/config/schema.ts` via ESM `import` syntax cannot be loaded directly by Node's native TypeScript support — a `.ts` extension inherits the package's module format (CommonJS here), and CommonJS-format files may not use `import`/`export` syntax, regardless of type-stripping. Bundling to a real `.mjs` output (the same pattern `scripts/build.mts` already uses to bundle `src/cli.ts`) sidesteps this without changing the package's module type or duplicating the schema definitions.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

async function main(): Promise<void> {
  fs.mkdirSync(distDir, { recursive: true });
  const outfile = path.join(distDir, "gen-schema-core.mjs");

  await esbuild.build({
    entryPoints: [path.join(__dirname, "gen-schema-core.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: `node${process.versions.node.split(".")[0]}`,
    outfile,
    external: ["zod"],
    logLevel: "info",
  });

  await import(pathToFileURL(outfile).href);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

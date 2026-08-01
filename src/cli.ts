import path from "node:path";

import { cosmiconfigReader } from "./config/load";

/**
 * Placeholder entrypoint for the Node SEA packaging proof-of-concept (build order Phase 2).
 *
 * This is deliberately not the real CLI yet — no resolver, no launcher, no Commander tree. Its only jobs are (1) proving the two-binary-name dispatch pattern the real `cli.ts` will rely on (`path.basename(process.argv[1])` correctly reflects whichever of `claude`/`claude-use` the built SEA binary was invoked as), and (2) proving a real dependency already used by the resolver core (cosmiconfig, via `src/config/load.ts`) still works when bundled and run from inside the packaged single-executable binary, not just under `node` in dev mode. A later phase replaces this file with the real dispatch to the launcher and the `claude-use` Commander tree.
 */
function main(): void {
  const fixtureFlagIndex = process.argv.indexOf("--read-fixture");
  if (fixtureFlagIndex !== -1) {
    const fixturePath = process.argv[fixtureFlagIndex + 1];
    if (fixturePath === undefined) {
      console.error("--read-fixture requires a file path argument");
      process.exitCode = 1;
      return;
    }
    const read = cosmiconfigReader();
    const config = read(fixturePath);
    console.log(JSON.stringify(config));
    return;
  }

  const invokedName = path.basename(process.argv[1] ?? "claude-use");
  console.log(invokedName);
}

main();

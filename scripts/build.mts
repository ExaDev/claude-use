import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

/**
 * Bundles `src/cli.ts` with esbuild into a single CJS file, then — unless `--bundle-only` is given — invokes the now-stable `node --build-sea=<config>` single command (Node >= v25.5.0) to produce a self-contained single-executable-application binary.
 *
 * This deliberately does NOT use the older `--experimental-sea-config` + manual `postject` pipeline the README used to describe — `--build-sea` handles bundle-copy, signature removal, blob injection, and re-signing in one step, and postject is not a dependency of this project.
 *
 * macOS SEA support is verified/tested upstream on arm64 only; x64 is explicitly unsupported and skipped in Node's own test suite. This script builds for whatever architecture it runs on and does not claim portability beyond that — a later CI phase attempts x64 as clearly-labelled best-effort, separate from this local build.
 *
 * `--bundle-only` produces just `dist/cli.cjs` (with a `#!/usr/bin/env node` shebang) and skips every SEA-specific step — this is what `npm publish`'s own `prepublishOnly` script runs, since the npm-distributed package needs the plain bundle to execute under the installer's own Node, not a platform-specific native binary with an embedded runtime.
 */
const bundleOnly = process.argv.includes("--bundle-only");

/** The lowest Node version this bundle is ever asked to run under — set by `commander@15`'s own `engines.node`, the strictest floor among this project's runtime dependencies, and mirrored in package.json's own `engines` field. Fixed rather than tied to whichever Node version happens to run this build script: the SEA binary embeds its own runtime regardless, and the npm-published bundle runs under whatever Node the installer has, which is only guaranteed to be at least this floor. */
const ESBUILD_TARGET = "node22";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const bundleFileName = "cli.cjs";
const seaConfigFileName = "sea-config.json";
const outputBinaryName = process.platform === "win32" ? "claude-use-sea.exe" : "claude-use-sea";

function requireBuildSeaSupport(): void {
  const [major, minor] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
  const supported = major !== undefined && minor !== undefined && (major > 25 || (major === 25 && minor >= 5));
  if (!supported) {
    throw new Error(
      `node --build-sea requires Node >= v25.5.0 (this stable single-command form shipped there); ` +
        `running Node v${process.versions.node}. Confirm the installed Node version before building.`,
    );
  }
}

async function bundle(): Promise<void> {
  await esbuild.build({
    entryPoints: [path.join(rootDir, "src", "cli.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: ESBUILD_TARGET,
    outfile: path.join(distDir, bundleFileName),
    // A shebang is inert for the SEA build (Node's CommonJS loader strips a leading `#!` line from any entry point regardless) and required for the npm-published bin script to be directly executable.
    banner: { js: "#!/usr/bin/env node" },
    minify: false,
    logLevel: "info",
  });
  fs.chmodSync(path.join(distDir, bundleFileName), 0o755);
}

function writeSeaConfig(): string {
  const seaConfigPath = path.join(distDir, seaConfigFileName);
  // Schema per https://nodejs.org/api/single-executable-applications.html — every field here is read directly from that page, not guessed. Paths are relative to `distDir`, since that is where `node --build-sea=` is invoked from below.
  const seaConfig = {
    main: bundleFileName,
    output: outputBinaryName,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  fs.writeFileSync(seaConfigPath, `${JSON.stringify(seaConfig, null, 2)}\n`);
  return seaConfigPath;
}

function buildSea(seaConfigPath: string): string {
  const outputPath = path.join(distDir, outputBinaryName);
  if (fs.existsSync(outputPath)) {
    fs.rmSync(outputPath);
  }
  try {
    execFileSync(process.execPath, [`--build-sea=${path.basename(seaConfigPath)}`], {
      cwd: distDir,
      stdio: ["ignore", "inherit", "pipe"],
    });
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String((error as { stderr: unknown }).stderr) : "";
    if (stderr.includes("Single executable application is disabled")) {
      throw new Error(
        `${process.execPath} was built with the single-executable-application feature disabled ` +
          "(confirmed on Homebrew's macOS Node distribution). Re-run this build with a Node binary " +
          "from a distribution that supports it — the official nodejs.org build, or a version " +
          "manager installing upstream builds (mise, nvm, volta, fnm) — ahead of it on PATH.",
      );
    }
    if (stderr.length > 0) {
      console.error(stderr);
    }
    throw error;
  }

  if (process.platform === "darwin") {
    // SEA binaries must be re-signed on macOS after blob injection invalidates the original signature. Ad-hoc signing (`-`) is sufficient for local use and for CI runners; a real release build may want a proper Developer ID signature instead, added in a later phase.
    execFileSync("codesign", ["--sign", "-", outputPath], { stdio: "inherit" });
  }

  fs.chmodSync(outputPath, 0o755);
  return outputPath;
}

function reportSize(outputPath: string): void {
  const { size } = fs.statSync(outputPath);
  const mib = size / (1024 * 1024);
  console.log(`Built ${outputPath} (${mib.toFixed(1)} MiB)`);
}

async function main(): Promise<void> {
  fs.mkdirSync(distDir, { recursive: true });
  await bundle();
  if (bundleOnly) {
    reportSize(path.join(distDir, bundleFileName));
    return;
  }
  requireBuildSeaSupport();
  const seaConfigPath = writeSeaConfig();
  const outputPath = buildSea(seaConfigPath);
  reportSize(outputPath);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

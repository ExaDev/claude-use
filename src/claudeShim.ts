import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { z } from "zod";

import { readJson, writeJsonAtomic } from "./config/store";
import { findExecutableInDir } from "./realPorts";
import type { LayoutPaths } from "./paths";

/** The claude-shim.json marker's own shape: never hand-edited, so it lives here rather than in `src/config/schema.ts`'s user-editable schemas (and is correctly excluded from `scripts/gen-schema.mts`'s published-schema generation, which only ever imports from that file). */
export const ClaudeShimStateSchema = z.strictObject({
  targetPath: z.string().min(1),
  method: z.enum(["hardlink", "copy"]),
  installedAtMs: z.number(),
});
export type ClaudeShimState = z.infer<typeof ClaudeShimStateSchema>;

/** Raised by enableClaudeShim/disableClaudeShim when the target path exists but doesn't look like claude-use's own doing (no matching claude-shim.json marker, and not a hardlink of the currently-running executable) — refuses rather than silently clobbering or deleting something an installer never created. Bypassed by --force. */
export class ForeignClaudeEntryError extends Error {
  constructor(
    readonly targetPath: string,
    readonly action: "enable" | "disable",
  ) {
    super(
      `${targetPath} already exists and does not look like something claude-use created. Refusing to ` +
        `${action === "enable" ? "overwrite" : "remove"} it automatically — inspect it yourself, or pass --force if you're sure.`,
    );
    this.name = "ForeignClaudeEntryError";
  }
}

/** Raised by enableClaudeShim when the running executable cannot possibly be turned into a directly-runnable `claude` command: an npm/Node install of claude-use on Windows, which has no bundled .exe and no shebang-based dispatch the way POSIX does. Not bypassed by --force — this isn't a safety refusal, it's "this would produce a broken file." */
export class UnsupportedShimSourceError extends Error {
  constructor(readonly ownExecutablePath: string) {
    super(
      `Cannot create a working \`claude\` command from ${ownExecutablePath} on Windows: an npm-installed ` +
        "claude-use running under Node.js has no .exe to hardlink/copy, and Windows has no shebang-based " +
        "dispatch the way POSIX does. Install claude-use via Scoop instead (see README), which ships a real " +
        "claude-use.exe this command can link from.",
    );
    this.name = "UnsupportedShimSourceError";
  }
}

/**
 * The exact filename to create: `claude.exe` when the running executable is itself a `.exe` (Windows needs the extension to recognise it as directly executable at all), `claude` for every other case.
 *
 * Deliberately not "preserve whatever extension the source has" — an npm install's own file is `cli.cjs`, and a bare `claude` (not `claude.cjs`) is what makes it invocable as the expected command on POSIX, where a shebang plus the executable bit is what matters, not the filename's extension.
 */
export function claudeTargetFilename(ownExecutablePath: string): string {
  return ownExecutablePath.toLowerCase().endsWith(".exe") ? "claude.exe" : "claude";
}

/**
 * The directories `discoverClaudeBinary`'s PATH-fallback search must exclude to avoid recursively discovering/spawning this very tool: wherever the running executable itself lives, plus wherever `shim enable` last placed a `claude`-named copy, when that's a *different* directory (i.e. `--dir` was used). Without folding the recorded shim directory in here too, `claude-use run`/`claude-use doctor` would only exclude their own directory, not a `--dir`-placed shim living elsewhere on PATH.
 */
export function resolveOwnInstallDirs(paths: LayoutPaths, ownExecutablePath: string): string[] {
  const dirs = [path.dirname(ownExecutablePath)];
  const state = readJson(paths.claudeShimFile, ClaudeShimStateSchema);
  if (state !== undefined) {
    dirs.push(path.dirname(state.targetPath));
  }
  return dirs;
}

/** Where `shim enable` places `claude` absent a --dir override: alongside the running executable. */
export function resolveClaudeTargetPath(ownExecutablePath: string, dir?: string): string {
  return path.join(dir ?? path.dirname(ownExecutablePath), claudeTargetFilename(ownExecutablePath));
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isCrossDeviceError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EXDEV";
}

function lstatOrUndefined(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
}

/** The two low-level fs calls the hardlink-then-copy-fallback needs, matching `src/config/store.ts`'s own `StoreFs`/`nodeStoreFs`-with-a-real-default pattern — the one seam in this file that isn't plain `node:fs`, added so the EXDEV fallback branch gets real unit coverage without a genuine cross-filesystem test rig. */
export interface LinkFs {
  readonly link: (existingPath: string, newPath: string) => void;
  readonly copyFile: (src: string, dest: string) => void;
  readonly chmod: (target: string, mode: number) => void;
}
export const nodeLinkFs: LinkFs = { link: fs.linkSync, copyFile: fs.copyFileSync, chmod: fs.chmodSync };

/** Inputs to `enableClaudeShim`. */
export interface EnableShimParams {
  readonly paths: LayoutPaths;
  /** process.argv[1] ?? process.execPath, supplied by the wiring layer. */
  readonly ownExecutablePath: string;
  /** process.platform, supplied by the wiring layer — only used for the Windows/npm-source guard. */
  readonly platform: string;
  readonly dir?: string;
  readonly force: boolean;
}

export type EnableShimAction = "enabled" | "reenabled";
export interface EnableShimResult {
  readonly action: EnableShimAction;
  readonly targetPath: string;
  readonly method: "hardlink" | "copy";
}

/**
 * Creates a `claude`-named hardlink (falling back to a copy on a cross-device filesystem) of the currently running `claude-use` executable, so `claude @<name>` works directly instead of needing `claude-use run`.
 *
 * A target that already exists is only ever overwritten when it's provably claude-use's own doing — either it shares an inode with the currently-running executable (covers a pre-existing install from before this feature existed, where no marker could possibly exist yet), or claude-shim.json records this exact target path (covers refreshing after a claude-use upgrade, when the old target's inode no longer matches the new binary's content). Anything else is refused unless `force` is set — this could otherwise silently delete or overwrite someone's genuine, unrelated `claude` binary.
 */
export function enableClaudeShim(params: EnableShimParams, linkFs: LinkFs = nodeLinkFs): EnableShimResult {
  const realOwnPath = fs.realpathSync(params.ownExecutablePath);

  if (params.platform === "win32" && !realOwnPath.toLowerCase().endsWith(".exe")) {
    throw new UnsupportedShimSourceError(realOwnPath);
  }

  // Deliberately targets alongside the executable *as invoked* (params.ownExecutablePath), not its realpath: a package manager's own PATH-visible entry is very often a symlink into some other directory entirely (e.g. Homebrew's `/opt/homebrew/bin/claude-use` -> `../Cellar/claude-use/<version>/bin/claude-use`), and the new `claude` shim needs to land next to that PATH-visible symlink, not buried in the Cellar keg alongside the dereferenced target where nothing on PATH would ever find it. The link *source* below still uses the resolved realOwnPath, so the hardlink/copy is always of the real file, never a symlink-of-a-symlink.
  const targetPath = resolveClaudeTargetPath(params.ownExecutablePath, params.dir);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const existing = lstatOrUndefined(targetPath);
  if (existing !== undefined) {
    const ownStat = fs.statSync(realOwnPath);
    const state = readJson(params.paths.claudeShimFile, ClaudeShimStateSchema);
    const sameInode = existing.dev === ownStat.dev && existing.ino === ownStat.ino;
    const markerMatches = state !== undefined && path.resolve(state.targetPath) === targetPath;
    if (!sameInode && !markerMatches && !params.force) {
      throw new ForeignClaudeEntryError(targetPath, "enable");
    }
    fs.rmSync(targetPath, { recursive: true, force: true });
  }

  let method: "hardlink" | "copy";
  try {
    linkFs.link(realOwnPath, targetPath);
    method = "hardlink";
  } catch (error) {
    if (!isCrossDeviceError(error)) {
      throw error;
    }
    linkFs.copyFile(realOwnPath, targetPath);
    linkFs.chmod(targetPath, 0o755);
    method = "copy";
  }

  const newState: ClaudeShimState = { targetPath, method, installedAtMs: Date.now() };
  writeJsonAtomic(params.paths.claudeShimFile, newState);

  return { action: existing === undefined ? "enabled" : "reenabled", targetPath, method };
}

export type DisableShimAction = "disabled" | "not-enabled";
export interface DisableShimResult {
  readonly action: DisableShimAction;
  readonly targetPath: string;
}

export interface DisableShimParams {
  readonly paths: LayoutPaths;
  readonly ownExecutablePath: string;
  readonly dir?: string;
  readonly force: boolean;
}

/** The inverse of `enableClaudeShim`: removes the `claude` command it created, using the same "is this ours" safety check. A no-op, not an error, when nothing is enabled — including clearing a dangling marker whose target has since been deleted by other means. */
export function disableClaudeShim(params: DisableShimParams): DisableShimResult {
  // See enableClaudeShim's own comment: targetPath is derived from the executable as invoked, never its realpath, since a package manager's PATH-visible entry is often a symlink elsewhere (Homebrew's Cellar). realOwnPath is only used below to compare inodes for the "is this ours" safety check.
  const realOwnPath = fs.realpathSync(params.ownExecutablePath);
  const state = readJson(params.paths.claudeShimFile, ClaudeShimStateSchema);
  const targetPath =
    params.dir !== undefined
      ? path.join(params.dir, claudeTargetFilename(params.ownExecutablePath))
      : (state?.targetPath ?? resolveClaudeTargetPath(params.ownExecutablePath));

  const existing = lstatOrUndefined(targetPath);
  if (existing === undefined) {
    if (state !== undefined) {
      fs.rmSync(params.paths.claudeShimFile, { force: true });
    }
    return { action: "not-enabled", targetPath };
  }

  const ownStat = fs.statSync(realOwnPath);
  const sameInode = existing.dev === ownStat.dev && existing.ino === ownStat.ino;
  const markerMatches = state !== undefined && path.resolve(state.targetPath) === targetPath;
  if (!sameInode && !markerMatches && !params.force) {
    throw new ForeignClaudeEntryError(targetPath, "disable");
  }

  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.rmSync(params.paths.claudeShimFile, { force: true });
  return { action: "disabled", targetPath };
}

export type PathShadowStatus =
  | { readonly status: "ok" }
  | { readonly status: "not-on-path" }
  | { readonly status: "shadowed"; readonly by: string };

export interface FindPathShadowParams {
  readonly pathDirs: readonly string[];
  readonly targetDir: string;
  readonly targetFilename: string;
  readonly findExecutableInDir: (dir: string, name: string) => string | undefined;
}

/** Would something else on PATH run before the just-enabled `claude`? Reuses the exact PATH-scan semantics `discoverClaudeBinary`'s own fallback already uses (via the injected `findExecutableInDir`), rather than shelling out to `command -v` — this answers a more directly relevant question ("would this tool's own binary discovery find this file first") without spawning a process at all. */
export function findPathShadow(params: FindPathShadowParams): PathShadowStatus {
  const resolvedTargetDir = path.resolve(params.targetDir);
  for (const dir of params.pathDirs) {
    const found = params.findExecutableInDir(dir, params.targetFilename);
    if (found === undefined) {
      continue;
    }
    return path.resolve(dir) === resolvedTargetDir ? { status: "ok" } : { status: "shadowed", by: found };
  }
  return params.pathDirs.some((dir) => path.resolve(dir) === resolvedTargetDir) ? { status: "ok" } : { status: "not-on-path" };
}

/**
 * Registers `claude-use shim enable`/`claude-use shim disable` onto `program`.
 *
 * `shim` is a deliberate noun-group, matching `identity`/`profile`/`rules` — it names the actual mechanism (a PATH-level executable that dispatches by invoked name, the same concept Scoop itself calls a "shim"), so `enable`/`disable` read as toggling one clearly-scoped thing rather than "installing"/"uninstalling" software, which could be misread as installing Claude Code itself.
 */
export function registerShimCommand(program: Command, paths: LayoutPaths): void {
  const shim = program
    .command("shim")
    .description(
      "Manage the `claude` command shim — an optional, explicit way to also invoke this launcher as `claude` " +
        "instead of `claude-use run`. Off by default; every installer ships only `claude-use`.",
    );

  shim
    .command("enable")
    .description("Create a `claude`-named copy of this same executable, alongside claude-use by default.")
    .option("--dir <path>", "Enable into this directory instead of alongside the running claude-use executable.")
    .option("--force", "Overwrite the target even if it doesn't look like claude-use's own doing.")
    .action((options: { dir?: string; force?: boolean }) => {
      const ownExecutablePath = process.argv[1] ?? process.execPath;
      const result = enableClaudeShim({
        paths,
        ownExecutablePath,
        platform: process.platform,
        ...(options.dir === undefined ? {} : { dir: path.resolve(options.dir) }),
        force: options.force ?? false,
      });
      console.log(`${result.action === "enabled" ? "Installed" : "Reinstalled"} \`claude\` at ${result.targetPath} (${result.method}).`);

      const shadow = findPathShadow({
        pathDirs: (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== ""),
        targetDir: path.dirname(result.targetPath),
        targetFilename: path.basename(result.targetPath),
        findExecutableInDir,
      });
      if (shadow.status === "not-on-path") {
        console.warn(`warning: ${path.dirname(result.targetPath)} is not on PATH — add it, or use \`claude-use run\` instead.`);
      } else if (shadow.status === "shadowed") {
        console.warn(
          `warning: 'claude' on PATH currently resolves to ${shadow.by}, not ${result.targetPath}. ` +
            `Put ${path.dirname(result.targetPath)} ahead of it on PATH.`,
        );
      }
    });

  shim
    .command("disable")
    .description("Remove the `claude` command shim `shim enable` previously created. A no-op, not an error, if none is enabled.")
    .option("--dir <path>", "Look in this directory instead of trusting the recorded location.")
    .option("--force", "Remove the target even if it doesn't look like claude-use's own doing.")
    .action((options: { dir?: string; force?: boolean }) => {
      const ownExecutablePath = process.argv[1] ?? process.execPath;
      const result = disableClaudeShim({
        paths,
        ownExecutablePath,
        ...(options.dir === undefined ? {} : { dir: path.resolve(options.dir) }),
        force: options.force ?? false,
      });
      console.log(
        result.action === "disabled"
          ? `Removed \`claude\` at ${result.targetPath}.`
          : `No \`claude\` command enabled at ${result.targetPath}; nothing to do.`,
      );
    });
}

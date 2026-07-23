# claude-use

A profile manager and launcher for [Claude Code](https://claude.com/claude-code) that lets one person run multiple logins from one machine while controlling — precisely, and per working directory — what gets shared between them.

## The problem

Claude Code keeps everything it knows in one place: `~/.claude`. Skills, memory, conventions, but also every conversation transcript, session file, and task list you've ever produced, across every project you've ever touched. If you want a second login (a personal account alongside a work one, say) or you want to keep one client's work cleanly separated from another's, there's no built-in way to say "share the skills and conventions, but not the history" — it's all one directory, all or nothing.

`claude-use` solves this with two independent things:

- **An identity** is a login. It's the thing that owns credentials and daemon state, and it's what you switch between with `claude @work` or `claude @personal`.
- **A configuration profile** is a reusable, named bundle of sharing rules — what's visible, what isn't. It exists independently of any identity, and which one applies can depend entirely on which directory you're working in.

Keeping these separate matters because they answer different questions. "Which login am I using?" and "What should this login see right now?" don't have to have the same answer every time, and forcing them to share one concept (as most ad hoc setups do) means you can't express "one login, several different sharing postures depending on where I am" — which turns out to be the common case.

## Install

```bash
curl -fsSL https://github.com/ExaDev/claude-use/releases/latest/download/install.sh | sh
```

This installs two binaries, `claude` and `claude-use`, into `~/.local/bin`. They're actually the same compiled executable — it decides which behaviour to run based on the name it was invoked as. No Node.js installation is required; both binaries are self-contained ([Node SEA](https://nodejs.org/api/single-executable-applications.html) builds).

Make sure `~/.local/bin` precedes any other `claude` installation (Homebrew, npm global, the native updater's own shim) on your `PATH`, since this `claude` needs to be the one that actually runs.

## Quick start

```bash
claude-use identity add personal      # create your first identity (a fresh login)
claude @personal                      # log in and start using it
```

That's it — with no further configuration, everything in `~/.claude` that isn't credentials or daemon runtime is classified into categories (see below) and shared according to sensible defaults. Add a second identity, add configuration profiles, and add directory rules only once you actually need more control than that.

## Concepts

### Identities

An identity is a directory at `~/.claude-use/identities/<name>/` — a symlink farm mirroring the parts of `~/.claude` that are configured to be shared, plus its own locally-written credentials and daemon state that are never shared with any other identity. This is what `CLAUDE_CONFIG_DIR` points at when you run `claude` under that identity.

Select an identity with:

- `claude @<name>` — for this one invocation
- `CLAUDE_ACCOUNT=<name> claude` — equivalent, via environment variable
- `claude-use identity use <name>` — persistently, until changed again

A directory rule (see below) can also pin a specific identity to a path, overriding whichever one is otherwise active — useful as a safety net so a particular client's directory always uses the right login regardless of habit.

### Configuration profiles

A configuration profile is a named, reusable JSON file at `~/.claude-use/config-profiles/<name>.json` describing what to share: category toggles, individual path overrides, and launch flags. It isn't tied to any identity. Which profile applies, for a given launch, is resolved in this order:

1. An explicit `--config-profile` flag or `CLAUDE_USE_CONFIG_PROFILE` environment variable (this run only)
2. A directory rule's `configProfile` selection for `$PWD` (see [Directory rules](#directory-rules))
3. The active identity's own declared default (`defaultConfigProfile` in its `identity.json`)
4. A global default (`~/.claude-use/config.json`)

Profiles compose hierarchically via `extends`:

```json
{ "extends": ["base", "work"], "categories": { "history": false } }
```

Resolving a profile means resolving its `extends` chain first, base to specific, then applying the profile's own overrides last — so a profile only has to state what's different from what it extends, and a whole tree of profiles (`base` → `work` → `client-strict` → one profile per client) shares as much as possible.

A single identity can use several configuration profiles, switching by directory. A single configuration profile can be reused by several identities. Someone with exactly one login can still get fully directory-scoped sharing behaviour purely from profiles and directory rules — a second login is never required just to get isolation.

## Category-based sharing

Every top-level entry in `~/.claude` is classified into one of five categories, shipped as a default map (`config/categories.default.json`):

| Category | Default shared? | Example entries |
|---|---|---|
| `secret` | **Never** — hardcoded, cannot be overridden by any configuration layer | `.credentials.json` |
| `runtime` | No | `daemon*`, `.git*`, `.DS_Store`, `mcp-needs-auth-cache.json`, `shell-snapshots`, `statsig`, `telemetry`, `stats-cache.json`, `usage-data`, `ide`, `cache`, `scheduled_tasks.lock` |
| `history` | No | `projects`, `sessions`, `teams`, `tasks`, `todos`, `history.jsonl`, `transcripts`, `paste-cache`, `file-history`, `plans`, `workflows`, `jobs`, `debug`, `downloads`, `chrome` |
| `knowledge` | Yes | `skills`, `agents`, `rules`, `memory`, `commands`, `plugins`, `hooks`, `AGENTS.md`, `CLAUDE.md`, `README.md` |
| `settings` | Yes | `settings.json`, `settings.local.json` |

This is a safe-by-default posture: only `knowledge` and `settings` are shared out of the box. A configuration profile can open up `history` (or anything else) wholesale, or share individual items within a closed category.

**Unclassified entries never disappear silently.** If Claude Code ever adds a new top-level file or directory this map doesn't recognise, the first time `claude-use` sees it, it prompts interactively (via `claude-use configure`) for a category, or "skip for now." The answer is written to a local overlay (`~/.claude-use/categories.local.json`) so it's never asked again, and the shipped default map stays untouched. In a non-interactive context (a script, a CI run), an unanswered entry stays excluded and gets reported, rather than the tool guessing or blocking.

### Path-level overrides

Any configuration layer — a profile, a directory rule, a committed `.claude-use.json` — can override sharing for one specific path, not just a whole category, and path keys may use glob wildcards:

```json
{ "categories": { "knowledge": false }, "entries": { "knowledge/skills/commit": true } }
```

shares exactly one skill even though the rest of `knowledge` is closed. The most specific matching path always wins.

### Conditional matching (`when`)

Both an entries value and a whole rule can be made conditional instead of a flat boolean:

```json
{ "entries": { "history/projects/*": { "value": true, "when": { "newerThan": "90d" } } } }
```

```json
{ "path": "~/work/clients/acme", "categories": { "history": false }, "when": { "branch": "client/*" } }
```

| Condition | Meaning |
|---|---|
| `newerThan` | Applies only while the entry's most recent modification is within the given duration |
| `olderThan` | The inverse of `newerThan` |
| `maxSizeBytes` | Applies only while the entry is at or under the given size |
| `branch` | Applies only while the repo at `$PWD` is checked out on a matching branch (glob-capable) |
| `env` | Applies only while the named environment variable equals the given value |

Conditions combine with AND logic within one `when` object. `cwd` is deliberately not a condition type — directory scoping already has its own first-class mechanism (below), so a generic condition would just be a worse way to do the same thing.

Because every launch resolves the cascade fresh, an age-based condition means "share only recent history" stays true automatically as time passes — no config edit needed as sessions age out. The one cost: a subtree matched by a conditional key can never use the cheap "one symlink for the whole subtree" shortcut, since the decision genuinely varies per file once mtimes are inspected.

## The cascade: how everything composes

Resolution proceeds through four layers, in order:

1. Shipped defaults (`categories.default.json`)
2. User-global override (`~/.claude-use/config.json`)
3. The active configuration profile's resolved overrides (itself the composition of its `extends` chain, then its own direct overrides)
4. Directory-hierarchy rules for `$PWD`, shallowest to deepest — each one composing in whichever configuration profile it selects plus any inline overrides

Every layer composes with what came before it; nothing is a wholesale replacement unless it explicitly overrides every entry that matters. Concretely, this happens in two phases:

**Phase one — flatten.** Walk the ordered layer sequence once, spreading each layer's `categories` and `entries` over an accumulator. A later layer's value for the exact same category name, or the exact same literal/glob entries key, replaces an earlier layer's value for that identical key. This is a plain shallow merge — no path-specificity reasoning happens here.

**Phase two — resolve per entry.** For each actual file under `~/.claude`, look up the flattened entries map for the most specific matching key: an exact literal path beats a glob that also matches it; among several matching globs, whichever survived phase one (i.e. the later layer) wins. Only if nothing in the entries map matches does the entry fall back to the flattened categories map.

The consequence worth internalising: **entries always outrank the category default, regardless of which layer set which.** A directory rule three levels deep that flips `categories: { history: false }` cannot silently undo an earlier, shallower layer's `entries: { "history/projects/acme": true }` — a category setting is definitionally the least specific override there is. To actually change that one path, a later layer has to set an equally-or-more-specific entry itself, not merely toggle the category.

`extends` resolves via this identical two-phase algorithm, recursively — each extended profile flattens to its own result first, then the profile's own overrides fold in last, so a profile's resolved patch is just one more input to the outer cascade, not a separate mechanism.

## Directory rules

Modelled on how Claude Code itself resolves nested `CLAUDE.md` files: walking up the directory tree, each level adding context. A directory-rules file at `~/.claude-use/directory-rules.json`:

```json
{
  "rules": [
    { "path": "~/work",                "configProfile": "work-default" },
    { "path": "~/work/clients",         "configProfile": "client-strict", "identity": "work" },
    { "path": "~/work/clients/example", "entries": { "knowledge/skills/example-notes": true } }
  ]
}
```

At launch, every rule whose `path` is an ancestor of (or equal to) `$PWD` is collected, sorted shallowest-first, and folded into the cascade in order. A rule's `configProfile` composes in rather than swapping in wholesale — `client-strict` above might itself extend `work-default`, so the deeper rule is saying "here's what's additionally true this far down the tree." A rule's optional `identity` field pins which login applies for that path regardless of whichever identity is otherwise active — an explicit `@name`/`CLAUDE_ACCOUNT` on the command line still wins over a directory pin (it's the most deliberate, immediate signal), but a directory pin beats the plain global default, making it a genuine safety net: if you accidentally run the wrong login from inside a sensitive directory out of habit, the pin holds unless you explicitly override it.

Because the farm's content now depends on **(identity, resolved configuration profile, directory)**, not just identity, `claude` resolves the full cascade for `$PWD` and resyncs the active identity's farm in place on every single launch, before spawning the real binary — fast, since it's comparing and updating symlinks over a few dozen entries, not rebuilding from scratch.

## Portable config: `.claude-use.json`

`~/.claude-use/directory-rules.json` is local to one machine and keyed by absolute path — it doesn't survive being shared with a teammate, or even the same person cloning a repo to a different location. A `.claude-use.json` file committed at a project's root closes that gap. It's discovered exactly the way nested `CLAUDE.md` files are: every `.claude-use.json` found while walking upward from `$PWD` is collected, sorted shallowest-first, and folded into the cascade like a directory rule — except its scope is implicit (wherever the file lives, and everything below it) rather than an explicit `path` field, so it works identically no matter where the repo is checked out.

The walk stops at (and includes) the user's home directory by default, configurable via `walkUpLimit` in `~/.claude-use/config.json` if it genuinely needs widening or narrowing. If the walk hits a directory it can't read, it stops there rather than failing the launch.

A `.claude-use.json` is self-contained by default:

```json
{ "categories": { "history": false }, "entries": { "knowledge/skills/commit": true } }
```

It may also reference a named `configProfile`, resolved first against any profile shipped in a sibling `.claude-use/profiles/` directory in the same repo, falling back to the user's own local `~/.claude-use/config-profiles/` — so a team can keep everything inline and portable, or ship a small reusable profile library alongside the pointer file.

**A per-repo local override pairs with the committed file.** Alongside `.claude-use.json`, an optional `.claude-use.local.json` in the same directory — gitignored, never committed — carries personal tweaks specific to that one clone. Add `.claude-use.local.json` to your project's `.gitignore` the same way you'd gitignore any other personal override file.

At a given directory level, up to three sources can apply, composed most-personal-last: the committed `.claude-use.json` (team-shared), then this user's own `~/.claude-use/directory-rules.json` entry for that path if one exists (cross-repo, this user's default), then `.claude-use.local.json` in that directory if present (this one repo, this user, never committed).

This turns "one login, two isolated clients, a few shared skills" (see [Examples](#examples)) into something a whole team gets automatically: instead of every teammate hand-writing a local directory rule, a repo ships its own `.claude-use.json` declaring the isolation/sharing rules directly, and anyone who clones it and runs `claude` from inside it gets the same behaviour with zero local setup.

## Pattern matching against `~/.claude/projects/`

Claude Code names each entry under `~/.claude/projects/` by encoding the absolute working directory a session ran from — empirically, `/` becomes `-` (a session run from `/Users/alice/work/clients/acme` produces `~/.claude/projects/-Users-alice-work-clients-acme`). This encoding is one-directional and not safely reversible (existing hyphens in real path segments are indistinguishable from encoded slashes), so `claude-use` never tries to decode a directory name back to a path. Instead, any glob pattern written in real-path terms — a directory-rule `path`, or a `history/projects/...` entry override — gets the same transform applied (literal separators become `-`, wildcards pass through unchanged) and is matched directly against the literal directory names present under `~/.claude/projects/`.

This means a single rule like:

```json
{ "path": "~/work/clients/*", "categories": { "history": true } }
```

resolves to sharing exactly the project-history subdirectories for every matching client directory, without hand-listing each project's exact encoded name.

## Launch flags

`skipPermissions` and `remoteControl` resolve through the same cascade as everything else (shipped default: both off), plus a one-off environment variable escape hatch:

```bash
CLAUDE_USE_SKIP_PERMISSIONS=1 claude
CLAUDE_USE_REMOTE_CONTROL=1 claude
```

`$CLAUDE_EXTRA_FLAGS` is passed straight through to the underlying `claude` binary.

## CLI reference

| What you're setting | Global (persistent) | Temporary (this run only) | Directory-scoped (persistent) |
|---|---|---|---|
| **Identity** | `claude-use identity use <name>` | `claude @<name>` / `CLAUDE_ACCOUNT=<name> claude` | `claude-use rules add <path> --identity <name>`; or `.claude-use.json`'s `"identity"` |
| **Configuration profile** | `claude-use profile set-default <name>`; or `claude-use identity set-default-profile <identity> <name>` | `claude --config-profile <name>` / `CLAUDE_USE_CONFIG_PROFILE=<name> claude` | `claude-use rules add <path> --profile <name>`; or `.claude-use.json`'s `"configProfile"` |
| **A category** | `claude-use profile set <name> --category history=true`; or `claude-use configure <name>` | `claude --category history=true` / `CLAUDE_USE_CATEGORY_OVERRIDE="history=true"` | `claude-use configure <profile-or-rule>`; or `.claude-use.json`'s `"categories"` |
| **An individual entry** | `claude-use profile set <name> --entry "path"=true`; or `claude-use configure <name> <path>` | `claude --share <path>` / `claude --hide <path>` / `CLAUDE_USE_ENTRY_OVERRIDE="path=true"` | `claude-use configure <profile> <path>`; or `.claude-use.json`'s `"entries"` |
| **Launch flags** | `claude-use profile set <name> --skip-permissions` | `CLAUDE_USE_SKIP_PERMISSIONS=1 claude` / `CLAUDE_USE_REMOTE_CONTROL=1 claude` | rule's inline `"launch"` field; or `.claude-use.json`'s `"launch"` |

The scriptable `claude-use profile set ...` commands exist alongside the interactive picker specifically so this is automatable — CI, setup scripts, or a `.claude-use.json` generator don't need to drive an interactive prompt.

### Full command list

```
claude-use identity add <name>
claude-use identity use <name>
claude-use identity list
claude-use identity set-default-profile <identity> <profile>

claude-use profile create <name> [--extends <name>,<name>,...]
claude-use profile list
claude-use profile set-default <name>
claude-use profile set <name> --category <cat>=<bool>
claude-use profile set <name> --entry "<path>"=<bool>
claude-use profile set <name> --skip-permissions [--remote-control]

claude-use rules add <path> [--profile <name>] [--identity <name>]
claude-use rules list
claude-use rules remove <path>

claude-use configure [identity] [path]
claude-use check [path] [--identity <name>]
```

### Debugging: `claude-use check`

`claude-use check [path] [--identity <name>]` resolves the full cascade for the given path (default `$PWD`) and identity (default the active one), and prints the result — every entry's resolved state, which layer decided it, and which condition (if any) was evaluated and how — without touching the farm or spawning `claude` at all. This is the primary way to answer "why is X shared/hidden here" without launching a session to find out.

## Examples

### The core example: one login, two isolated clients, a few shared skills

```json
// ~/.claude-use/config-profiles/client-base.json
{
  "categories": { "knowledge": false, "history": false },
  "entries": {
    "knowledge/skills/commit": true,
    "knowledge/skills/pr-feedback": true,
    "knowledge/rules": true
  }
}
```

```json
// ~/.claude-use/config-profiles/client-acme.json
{ "extends": ["client-base"] }
```

```json
// ~/.claude-use/config-profiles/client-widget.json
{ "extends": ["client-base"] }
```

```json
// ~/.claude-use/directory-rules.json
{
  "rules": [
    { "path": "~/work/clients/acme",   "configProfile": "client-acme" },
    { "path": "~/work/clients/widget", "configProfile": "client-widget" }
  ]
}
```

One login serves both clients. History is fully isolated between them; `commit`, `pr-feedback`, and `rules` stay available in both. If "isolated" should mean each client still sees its own past sessions rather than none at all, add a glob entry override scoped to that client's own encoded project directories (see [Pattern matching](#pattern-matching-against-claudeprojects)) rather than opening `history` wholesale.

### More scenarios

**Two logins, a directory rule as a safety net independent of which one is active.** A `personal` identity defaults to sharing history everywhere; a `work` identity defaults to not sharing it. One client is under a strict no-cross-contamination requirement:

```json
{ "rules": [{ "path": "~/work/clients/regulated-client", "configProfile": "client-strict" }] }
```

If `claude @personal` is ever run from inside that same directory — intentionally or by habit — the rule still applies, because rules aren't tied to identity. History stays off no matter which login is active.

**A team repo ships its own config; a new teammate needs zero setup.** A project commits `.claude-use.json` at its root:

```json
{ "categories": { "history": false }, "entries": { "knowledge/skills/commit": true, "knowledge/skills/pr-feedback": true } }
```

A new teammate installs `claude-use`, creates their own identity, clones the repo, and runs `claude` from inside it — they get the isolation-plus-shared-skills behaviour immediately, with no local configuration. If they want to see their own past sessions there too, that's a personal, local addition that composes on top of the committed file.

**Share-by-default, with narrow exceptions.** The inverse posture — broad sharing, a couple of carve-outs:

```json
{
  "rules": [
    { "path": "~/oss",                     "categories": { "history": true } },
    { "path": "~/oss/private-experiments", "categories": { "history": false } }
  ]
}
```

The deeper rule narrows what the shallower one opened up.

### Configuration permutation reference

A minimal progression, each adding one mechanism on top of the last:

1. **Bare minimum** — an identity, nothing else configured. Shipped defaults apply as-is.
2. **One configuration profile, no directory scoping** — `{ "categories": { "history": true } }` as an identity's default: that identity shares history everywhere.
3. **Directory rules switching profiles under one identity** — a `personal` profile and a `work` profile, a rule sending `~/work` to the latter.
4. **Linear `extends` chain** — `base` → `work` (extends `base`) → `client-acme` (extends `work`), each layer stating only what's different.
5. **Diamond `extends`** — a profile extending two others that disagree on one category; the later one in the list wins.
6. **A path-level override with the parent category closed** — one skill shared without opening the whole category.
7. **A directory rule adding an inline override deeper than the profile it selected** — a shared `client-strict` profile for `~/work/clients`, one extra skill for `~/work/clients/acme` specifically, no new profile needed.
8. **A glob entry override against `~/.claude/projects/`** — sharing history for every project matching a pattern, without listing each one.
9. **A portable `.claude-use.json`** — works identically for every clone location.
10. **Two identities sharing one configuration profile** — both declare the same `defaultConfigProfile`; nothing else needs to stay in sync between them.

## Architecture

One compiled binary backs both `claude` and `claude-use` — the entrypoint dispatches on `path.basename(process.argv[1])`, so installation just needs two differently-named copies (or hardlinks) of the same executable on `PATH`.

```
src/
  cli.ts                 # entrypoint; dispatches on invoked name -> launcher vs identity/profile-manager subcommands
  launcher.ts             # `claude` behaviour: resolve cascade for $PWD, resync farm, resolve launch flags, spawn real binary
  identityManager.ts      # `claude-use identity` subcommands
  configProfiles.ts       # `claude-use profile` subcommands (scriptable set/set-default alongside `create`/`list`)
  directoryRules.ts       # `claude-use rules` subcommands
  configure.ts            # interactive picker
  check.ts                # `claude-use check` dry-run inspector — no farm writes, no spawn
  resolve.ts              # pure cascade resolver — categories, path overrides, configuration profiles, directory rules,
                           # committed .claude-use.json / .claude-use.local.json discovery. The unit-tested core.
  versionDiscovery.ts     # portable "find the real claude binary" logic
  config/
    schema.ts             # Zod schemas: CategoryMap, ConfigProfile, DirectoryRules, GlobalConfig — single source of truth
    load.ts                # cosmiconfig load(filepath) wrapper (format-flexible parsing) + Zod validation
    categories.default.json
    directory-rules.example.json
resolve.test.ts + friends  # unit tests for the resolver
schema/                    # published JSON Schemas for IDE autocomplete
sea-config.json            # Node SEA build config
package.json / tsconfig.json
scripts/build.ts           # esbuild bundle -> single CJS file -> node --experimental-sea-config -> postject inject
install.sh                 # places built binaries as `claude` and `claude-use` in ~/.local/bin
```

### Why config file loading uses cosmiconfig's `load()`, never its `search()`

Every config file this tool reads — the global config, named configuration profiles, and each `.claude-use.json`/`.claude-use.local.json` found while walking the directory tree — is loaded with [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig)'s `load(filepath)`. Its `search()` method stops at the first config file found while walking upward; this design needs the opposite — every ancestor collected, shallowest-first — so `resolve.ts` does its own directory walk and calls `load()` at each level it visits, getting cosmiconfig's format flexibility (JSON, YAML, JS/TS, a `claude-use` key in `package.json`) without fighting its traversal semantics.

### Why `extends` isn't cosmiconfig's `$import`

cosmiconfig also supports an `$import` directive that deep-merges imported files, later imports winning — close to what `extends` needs. It isn't used for two reasons: it resolves imports by relative file path, not by profile name, so a name-to-path resolution step is needed regardless; and it has no awareness of the entries-beat-categories, most-specific-path-wins rule, which has to be bespoke either way. `resolve.ts` implements one flatten function, reused for both the `extends` chain and the outer cascade, rather than splitting the same conceptual merge across two implementations that could drift apart.

### Resolver mechanics

For each `~/.claude` entry, walk the cascade to a boolean decision. If the decision is uniform for an entire subtree, symlink that directory in one shot. If a deeper path override splits the decision, materialise that directory as a real local directory instead of a symlink and recurse, repeating the check at each level — only directories with an actual split ever get exploded. A conditional entries key is never eligible for the uniform-symlink shortcut, since its decision can only be evaluated per-file.

This logic is pure — `(claudeHome, cascade, path) => Map<path, boolean>` — and unit-tested without touching the filesystem before anything else is built on top of it.

### Build (Node SEA)

Bundle `src/cli.ts` to a single file with esbuild, generate the SEA blob with `node --experimental-sea-config`, then inject it into a copy of the Node binary with `postject`. Confirm the exact current steps against up-to-date Node documentation before implementing — the SEA feature is still evolving between Node releases. Initial target platforms are macOS arm64 and x64, built in CI on tag push and published as GitHub Release assets; add others only if actually needed.

## Testing strategy

`resolve.ts`'s cascade and materialisation logic is exactly the kind of thing that's easy to get subtly wrong, so it gets thorough unit tests before anything else is built on it:

- Each cascade layer overriding the last; path overrides beating their parent category
- Directory rules folding correctly for nested paths, and correctly composing configuration profiles mid-tree
- The `secret` category being unconditionally un-overridable
- Committed `.claude-use.json`/`.claude-use.local.json` files at different tree depths folding shallowest-to-deepest like local directory rules, composing correctly when both apply to the same directory
- Glob patterns matching correctly against literal `~/.claude/projects/` directory names, never attempting to decode a name back to a real path
- Multi-level and diamond `extends` chains resolving correctly
- One identity producing different resolved states under two different configuration profiles, with no leakage between them
- The exact two-phase merge algorithm: a shallow layer's specific entry surviving a later, deeper layer's blanket category flip on the same category; an exact literal key beating a glob from an earlier layer; two globs from different layers resolving to the later layer's value; two layers setting the identical category resolving to plain last-layer-wins
- Conditional entries with injectable/fake mtimes (not real filesystem timestamps, so tests aren't time-dependent or slow) — a `newerThan` condition including a fresh file and excluding a stale one under the same glob, and a conditionally-matched subtree always being materialised rather than symlinked

`launcher.ts`, `identityManager.ts`, `configProfiles.ts`, `directoryRules.ts`, and `configure.ts` stay thin adapters over `resolve.ts`, so most correctness lives in code that never touches the filesystem or a terminal.

## Contributing

Issues and pull requests are welcome. Please keep the tool itself free of assumptions about any particular organisation, client, or directory layout — it should work the same for anyone.

## License

TBD.

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

An identity is a directory at `~/.claude-use/identities/<name>/` — a symlink farm mirroring the parts of `~/.claude` that are configured to be shared, plus its own locally-written credentials and daemon state that are never shared with any other identity. This is what `CLAUDE_CONFIG_DIR` points at when you run `claude` under that identity. Alongside the farm, the identity directory holds one small, Zod-validated `identity.json` (created by `claude-use identity add`): the optional `defaultConfigProfile` used to resolve which configuration profile applies (per below), and the optional `allowAmbientCredential` boolean (default `false`) that opts this one identity out of the ambient-credential launch guard described next.

Select an identity with:

- `claude @<name>` — for this one invocation
- `CLAUDE_ACCOUNT=<name> claude` — equivalent, via environment variable (this is `claude-use`'s own variable, read by its launcher; Anthropic's own multi-account convention is a plain `CLAUDE_CONFIG_DIR=<path> claude`, which `claude-use` builds on top of rather than replaces)
- `claude-use identity use <name>` — persistently, until changed again

A directory rule (see below) can also pin a specific identity to a path, overriding whichever one is otherwise active — useful as a safety net so a particular client's directory always uses the right login regardless of habit.

**If `CLAUDE_CONFIG_DIR` is already set when `claude` runs, `claude-use` skips its own identity/cascade resolution entirely and lets the real binary use whatever it already points to** — the same "explicit signal wins" precedence used everywhere else in this design (an `@name` beats a directory pin, for instance). There is no farm to resync and no identity to resolve in this case, since you've named a configuration directory yourself. The ambient-credential guard below still runs regardless of this escape hatch — it's a check about credential isolation, not about identity or config-directory selection, so naming your own `CLAUDE_CONFIG_DIR` doesn't exempt you from it.

**Where the actual login credential lives, per platform, and where isolation can break down.** Claude Code fully relocates its own state under `CLAUDE_CONFIG_DIR` on every platform — including `.claude.json` (below) and, on Linux and Windows, `.credentials.json` — so on those platforms each identity's login is a genuinely separate file. **macOS is the exception**: Claude Code stores credentials in the encrypted macOS Keychain there, never in a `.credentials.json` file, regardless of `CLAUDE_CONFIG_DIR`. In practice this still isolates per identity — Keychain entries observed in the wild are named `Claude Code-credentials-<hash>`, distinctly per configuration directory, not one fixed item shared by every identity — but this namespacing isn't documented by Anthropic, only empirically observed, so treat it as verify-before-relying-on rather than a guaranteed contract, especially across Claude Code version changes.

**More importantly, on every platform, a handful of environment variables silently outrank whichever credential — file or Keychain — is stored for the active identity: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, and the `CLAUDE_CODE_USE_BEDROCK`/`VERTEX`/`FOUNDRY` family.** They authenticate Claude Code directly from the process environment, ahead of any stored subscription login, and none of them live inside `CLAUDE_CONFIG_DIR` — they come from whatever shell environment the process inherits. If any of these are set globally, every identity would silently authenticate as that same account or key, defeating the entire premise of separate identities — so rather than just warning about this, `claude` checks for all of them before every launch and **refuses to start** if any is present, naming exactly which one and why:

```
error: ANTHROPIC_API_KEY is set in the environment. This identity's isolated
credential would be bypassed — every identity authenticates as this same key
while it's set. Unset it, or if this is deliberate, opt in per-launch with
CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL=1, or persistently for this identity with
`claude-use identity set <name> --allow-ambient-credential`.
```

The check runs regardless of platform (it doesn't depend on the macOS Keychain caveat above — it's about the environment, not where the credential is stored) and is opt-out, not opt-in: a shared credential has to be a deliberate choice, made explicitly, not an ambient shell setting nobody remembers is there. `claude-use check` (below) also surfaces this proactively, without needing to actually attempt a launch to find out.

### Configuration profiles

A configuration profile is a named, reusable JSON file at `~/.claude-use/config-profiles/<name>.json` describing what to share: category toggles, individual path overrides, and launch flags. It isn't tied to any identity. Which profile applies, for a given launch, is resolved in this order:

1. An explicit `--config-profile <name>` flag or `CLAUDE_USE_CONFIG_PROFILE` environment variable (this run only)
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
| `secret` | **Never** — hardcoded, cannot be overridden by any configuration layer | `.credentials.json`, `backups` |
| `runtime` | No | `daemon*`, `.git*`, `.DS_Store`, `mcp-needs-auth-cache.json`, `shell-snapshots`, `statsig`, `telemetry`, `stats-cache.json`, `usage-data`, `ide`, `cache`, `scheduled_tasks.lock` |
| `history` | No | `projects`, `sessions`, `session-env`, `teams`, `tasks`, `todos`, `history.jsonl`, `transcripts`, `paste-cache`, `file-history`, `plans`, `workflows`, `jobs`, `debug`, `downloads`, `chrome` |
| `knowledge` | Yes | `skills`, `agents`, `rules`, `memory`, `commands`, `plugins`, `hooks`, `AGENTS.md`, `CLAUDE.md`, `README.md` |
| `settings` | Yes | `settings.json`, `settings.local.json` |

This is a safe-by-default posture: only `knowledge` and `settings` are shared out of the box. A configuration profile can open up `history` (or anything else) wholesale, or share individual items within a closed category.

`secret`'s "never, cannot be overridden" is an absolute check `resolve.ts` makes *before* running the two-phase cascade at all — not merely the least-specific layer in that cascade, the way every other category is. This matters because [The cascade](#the-cascade-how-everything-composes)'s general rule is that a specific `entries` override always beats a category default; `secret` is the one deliberate exception, so an explicit `entries: { "secret/.credentials.json": true }` anywhere in any layer is rejected outright, the same as a bare `categories: { secret: true }` would be — path-specificity never gets a chance to apply to this one category.

**`~/.claude.json` isn't in this table at all, because — unlike `backups/` above — it isn't sourced from `~/.claude` the way everything else here is.** It's a sibling *file* next to the `~/.claude` directory, not an entry inside it: the OAuth session, personal (user/local-scope) MCP server definitions, and per-project trust decisions (which directories you've approved Claude Code to run in, and what it's allowed to do there). It fully relocates to `$CLAUDE_CONFIG_DIR/.claude.json` when set, the same as everything else — confirmed both in Anthropic's own Agent SDK documentation and empirically in this project's own development. Because it's generated fresh by Claude Code itself the moment it first runs under a new `CLAUDE_CONFIG_DIR`, `claude-use` treats it the same way as `secret`: always identity-local, never part of the shared cascade, and — since it isn't even a descendant of `~/.claude` — never something the resolver's directory walk encounters at all, rather than something explicitly excluded by category. `~/.claude/backups/` holds rolling timestamped copies of it (capped at five, auto-rotating) for Claude Code's own config-migration safety; being a genuine descendant of `~/.claude`, it *is* something the resolver walks past, which is exactly why it's listed under `secret` in the table above rather than merely assumed safe.

**A category being "shared by default" doesn't mean everything inside it is safe to share — `settings` is the one to watch.** `settings.json`'s `env` and `hooks` fields accept literal values with no schema-level restriction, and Anthropic's own documented example for `env` shows a plain literal (`"FOO": "bar"`) with no interpolation syntax available for settings.json itself — the `${VAR}`/`${VAR:-default}` expansion Anthropic does document is scoped specifically to `.mcp.json`, not to `settings.json`'s own fields. In practice this means a hook command or an `env` entry in `settings.json` can easily end up holding a real API key or token, and nothing in Claude Code's own documentation warns against it. Since `settings` is shared across every identity and configuration profile by default, a literal secret placed there is available to all of them — including a client-separated profile that never opened `history`. If you keep genuine secrets in `settings.json`, either move them out (an MCP server's own `.mcp.json`, which does support `${VAR}` expansion, or an environment variable referenced rather than embedded), or close the `settings` category explicitly for any profile that shouldn't see them.

One more boundary worth naming: an IDE extension's own UI-level preferences (VS Code's `globalStorage`, JetBrains' own per-IDE settings store) live outside `~/.claude` entirely and aren't affected by switching identities — only the functional IDE-connection state (the auth lock file under `ide/`, already in the `runtime` category above) actually relocates per identity. Don't expect a per-identity theme or editor toggle from an IDE extension; do expect the IDE↔Claude Code connection itself to isolate correctly.

**Unclassified entries never disappear silently.** If Claude Code ever adds a new top-level file or directory this map doesn't recognise, the first time `claude-use` sees it, it prompts interactively (via `claude-use configure`) for a category, or "skip for now." The answer is written to a local overlay (`~/.claude-use/categories.local.json`) so it's never asked again, and the shipped default map stays untouched. In a non-interactive context (a script, a CI run), an unanswered entry stays excluded and gets reported, rather than the tool guessing or blocking.

### Path-level overrides

Any configuration layer — a profile, a directory rule, a committed `.claude-use.json` — can override sharing for one specific path, not just a whole category, and path keys may use glob wildcards:

```json
{ "categories": { "knowledge": false }, "entries": { "knowledge/skills/commit": true } }
```

shares exactly one skill even though the rest of `knowledge` is closed. The most specific matching path always wins.

All path and glob matching in this design (`entries` keys, directory-rule `path` values, `~/.claude/projects/` patterns) is byte-for-byte case-sensitive, deliberately independent of whether the underlying filesystem is. This matters because the initial [build target](#build-node-sea) is macOS, whose default APFS volume is case-insensitive-but-case-preserving — without a fixed policy, a config's literal key could resolve differently at the filesystem level than in `claude-use`'s own string matching whenever their casing disagreed, invisibly on that one platform. Case-sensitive matching everywhere means the same config behaves identically regardless of which platform's filesystem it runs on.

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
| `env` | Applies only while every named environment variable in the condition equals its given value (one or more, all required) |

Conditions combine with AND logic within one `when` object. `cwd` is deliberately not a condition type — directory scoping already has its own first-class mechanism (below), so a generic condition would just be a worse way to do the same thing.

Because every launch resolves the cascade fresh, an age-based condition means "share only recent history" stays true automatically as time passes — no config edit needed as sessions age out. The one cost: a subtree matched by a conditional key can never use the cheap "one symlink for the whole subtree" shortcut, since the decision genuinely varies per file once mtimes are inspected.

## The cascade: how everything composes

Resolution proceeds through four layers, in order:

1. Shipped defaults (`config/categories.default.json`)
2. User-global override (`~/.claude-use/config.json`)
3. The active configuration profile's resolved overrides (itself the composition of its `extends` chain, then its own direct overrides)
4. Directory-hierarchy rules for `$PWD`, shallowest to deepest — each one composing in whichever configuration profile it selects plus any inline overrides

Every layer composes with what came before it; nothing is a wholesale replacement unless it explicitly overrides every entry that matters. Concretely, this happens in two phases:

**Phase one — flatten.** Walk the ordered layer sequence once, spreading each layer's `categories` and `entries` over an accumulator. A later layer's value for the exact same category name, or the exact same literal/glob entries key, replaces an earlier layer's value for that identical key. This is a plain shallow merge — no path-specificity reasoning happens here.

**Phase two — resolve per entry.** For each actual file under `~/.claude`, look up the flattened entries map for every matching key and rank them by, in order: (1) **which layer set the rule — later layer wins, period**, ranked above exactness deliberately, because ranking exactness first would let an untrusted committed `.claude-use.json`'s exact key beat your own later, personal glob override, which would break this design's own stated trust property that a directory-scoped local rule can only ever tighten what a committed file opened, never the reverse; (2) same layer, an exact literal beats a glob; (3) same layer, the longer literal (non-wildcard) prefix wins; (4) same layer, more path segments wins (disambiguates `a/*` from `a/*/*` at the same prefix length); (5) same layer, later ordinal (source order within the file) wins. Only if nothing in the entries map matches at all does the entry fall back to the flattened categories map.

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

Because the farm's content now depends on **(identity, resolved configuration profile, directory)**, not just identity, `claude` resolves the full cascade for `$PWD` and resyncs the active identity's farm in place on every single launch, before spawning the real binary — fast, when the resolved decision is uniform across the categories in play, since it's comparing and updating symlinks over a few dozen top-level entries rather than rebuilding from scratch. This stops being cheap the moment a conditional override is in scope for a large subtree — `history/projects/` chief among them, since a `newerThan`/`olderThan`/`maxSizeBytes` condition (per [Conditional matching](#conditional-matching-when)) can never use the uniform-symlink shortcut and has to evaluate each project directory's own mtime/size individually, on every launch, with no caching described. For a long-lived identity with a lot of history, this is worth benchmarking early rather than assumed away.

Running two or more sessions concurrently under one identity — two terminals, each in a different client directory, is exactly the pattern directory rules are meant to support — means two resyncs can race to mutate the same shared farm toward two different resolved states. The launcher serialises this with a per-identity lock file (held for the duration of the resync, released before spawning `claude`) and builds each resync's changes as a scratch tree swapped into place with an atomic rename rather than mutating the live farm path-by-path in place, so a sibling session never observes a half-updated farm partway through someone else's resync.

## Portable config: `.claude-use.json`

`~/.claude-use/directory-rules.json` is local to one machine and keyed by absolute path — it doesn't survive being shared with a teammate, or even the same person cloning a repo to a different location. A `.claude-use.json` file committed at a project's root closes that gap. It's discovered exactly the way nested `CLAUDE.md` files are: every `.claude-use.json` found while walking upward from `$PWD` is collected, sorted shallowest-first, and folded into the cascade like a directory rule — except its scope is implicit (wherever the file lives, and everything below it) rather than an explicit `path` field, so it works identically no matter where the repo is checked out.

This is a different system from — and entirely independent of — a project's own `.claude/` directory (project-scoped `settings.json`, skills, hooks, commands, agents) or a project's `.mcp.json`. Claude Code resolves those directly from the current working directory's own repository tree regardless of `CLAUDE_CONFIG_DIR`, identity, or configuration profile, so switching identities never changes what a project's own committed Claude Code config does. `.claude-use.json` and `.claude-use.local.json` are `claude-use`'s own, separate convention, sitting alongside — never instead of — a project's ordinary `.claude/` setup.

The walk stops at (and includes) the user's home directory by default, configurable via `walkUpLimit` in `~/.claude-use/config.json` if it genuinely needs widening or narrowing. If the walk hits a directory it can't read, it stops there rather than failing the launch.

A `.claude-use.json` is self-contained by default:

```json
{ "categories": { "history": false }, "entries": { "knowledge/skills/commit": true } }
```

It may also reference a named `configProfile`, resolved first against any profile shipped in a sibling `.claude-use/config-profiles/` directory in the same repo, falling back to the user's own local `~/.claude-use/config-profiles/` — so a team can keep everything inline and portable, or ship a small reusable profile library alongside the pointer file.

**A per-repo local override pairs with the committed file.** Alongside `.claude-use.json`, an optional `.claude-use.local.json` in the same directory — gitignored, never committed — carries personal tweaks specific to that one clone. Add `.claude-use.local.json` to your project's `.gitignore` the same way you'd gitignore any other personal override file.

At a given directory level, up to three sources can apply, composed most-personal-last: the committed `.claude-use.json` (team-shared), then this user's own `~/.claude-use/directory-rules.json` entry for that path if one exists (cross-repo, this user's default), then `.claude-use.local.json` in that directory if present (this one repo, this user, never committed). This three-source fold happens once per directory level, and the whole shallowest-to-deepest walk (per [Directory rules](#directory-rules)) is one continuous sequence through those folded levels — a deeper level's three-source result composes on top of a shallower level's, not the other way around, and not gathered per-source across the whole tree first.

**A committed `.claude-use.json` is trusted automatically the first time you run `claude` inside a directory it covers — there is no confirmation step, by design, but you should know that before relying on it.** Because a repo's config can broaden what an identity shares (any category or entry short of the hardcoded `secret`) the moment you run `claude` inside it, cloning and running `claude` in an unfamiliar or untrusted repo changes what that identity's farm exposes for as long as you work there. If that's a concern for a given identity — a strict client-separated one, say — pin a directory rule for that path with `claude-use rules add <path> --profile <strict-profile>` (per [CLI reference](#cli-reference)) before ever running `claude` there for the first time: a directory-scoped local rule always composes after the committed file (most-personal-last, above), so it can only tighten what an untrusted `.claude-use.json` opened, never the reverse. `claude-use check <path>` also shows you exactly what a repo's `.claude-use.json` would resolve to before you ever run `claude` there.

This turns "one login, two isolated clients, a few shared skills" (see [Examples](#examples)) into something a whole team gets automatically: instead of every teammate hand-writing a local directory rule, a repo ships its own `.claude-use.json` declaring the isolation/sharing rules directly, and anyone who clones it and runs `claude` from inside it gets the same behaviour with zero local setup.

## Pattern matching against `~/.claude/projects/`

Claude Code names each entry under `~/.claude/projects/` by encoding the absolute working directory a session ran from into a single directory name — the one confirmed sample so far is `/` becoming `-` (a session run from `/Users/alice/work/clients/acme` produces `~/.claude/projects/-Users-alice-work-clients-acme`). **Treat this as an unverified hypothesis, not a settled fact, until checked against a real installation.** Before relying on it: run a handful of sessions from representative real paths — ones containing a literal `.` (version-numbered directories are common), spaces (common in macOS paths), deep nesting past ~200 characters, and any non-ASCII characters you expect to encounter — and confirm what actually lands under `~/.claude/projects/` for each. Path-flattening schemes commonly sanitise the whole non-alphanumeric character class rather than only the separator; if Claude Code does too, matching needs to account for that, not just `/`-to-`-`. Re-check after any Claude Code version bump, since this is unversioned, undocumented behaviour on Anthropic's side that this feature depends on without a contract.

The encoding is also **many-to-one, not merely hard to decode**: `~/work/clients/acme` and `~/work/clients-acme` (or `~/work-clients/acme`) all flatten to the identical string under a pure separator substitution. A pattern aimed at one can silently match its sibling instead — a real risk, not a theoretical one, for a tool whose whole purpose is precise per-client isolation. `claude-use check` should flag when a pattern's encoded form could plausibly correspond to more than one real path, rather than resolving silently. Because the encoding is one-directional and ambiguous in this way, `claude-use` never tries to decode a directory name back into a path — only the forward direction (real path → encoded form) is ever computed.

This forward transform only applies to entries keys under the fixed `history/projects/` prefix — nowhere else. Everywhere else in this design (directory-rule `path` fields, every other `entries` key), a path is always a literal filesystem path or a normal glob over one, matched exactly as written; **a directory-rule `path` is never matched against `~/.claude/projects/` and never gets this transform** — directory rules only ever match ancestors of `$PWD` (see [Directory rules](#directory-rules)). The one place the transform applies is deliberately narrow: anything written after the literal `history/projects/` prefix in an `entries` key is a real absolute path (optionally globbed), not a literal child directory name, since `history/projects/`'s only real children are Claude Code's own encoded directory names — there's nothing else meaningful to reference there. For example:

```json
{ "entries": { "history/projects/~/work/clients/*": true } }
```

shares exactly the project-history subdirectories for every real path under `~/work/clients/`, without hand-listing each project's exact encoded name — `claude-use` encodes the `~/work/clients/*` portion the same way Claude Code names its own directories, then matches it against the literal directory names present under `~/.claude/projects/`. This is narrower and correct where the earlier, broader-sounding `categories: { history: true }` on a whole directory would not be: that opens the entire `history` category (sessions, tasks, transcripts, and everything else in the [category table](#category-based-sharing)), not just `projects`.

This whole mechanism assumes POSIX-style absolute paths (forward-slash separators). That's a non-issue today since the initial [build target](#build-node-sea) is macOS only; if another platform is ever added, this section — and Claude Code's own encoding behaviour on that platform — needs independent re-verification, not an assumption that the same rule carries over.

## Launch flags

`skipPermissions` and `remoteControl` resolve through the same cascade as everything else (shipped default: both off), plus a one-off environment variable escape hatch:

```bash
CLAUDE_USE_SKIP_PERMISSIONS=1 claude
CLAUDE_USE_REMOTE_CONTROL=1 claude
```

`$CLAUDE_EXTRA_FLAGS` is passed straight through to the underlying `claude` binary.

### Ambient-credential guard

Before any of the above, the launcher checks the environment for `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and `CLAUDE_CODE_USE_FOUNDRY` (see [Identities](#identities) for why) and refuses to launch if any is present, unless the active identity has `allowAmbientCredential: true` in its `identity.json` or `CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL=1` is set for this one invocation. An empty string counts as unset for all six variables — this matters because clearing one of them with `export ANTHROPIC_API_KEY=""` (rather than `unset`), a real pattern in wrapper scripts that fall through to a different variable once the first is cleared, must not trip the guard:

```bash
CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL=1 claude   # this run only
claude-use identity set <name> --allow-ambient-credential   # persistently, for this identity
```

## CLI reference

| What you're setting | Global (persistent) | Temporary (this run only) | Directory-scoped (persistent) |
|---|---|---|---|
| **Identity** | `claude-use identity use <name>` (writes `~/.claude-use/active-identity`) | `claude @<name>` / `CLAUDE_ACCOUNT=<name> claude` | `claude-use rules add <path> --identity <name>`; or `.claude-use.json`'s `"identity"` |
| **Configuration profile** | `claude-use profile set-default <name>`; or `claude-use identity set-default-profile <identity> <profile>` | `claude --config-profile <name>` / `CLAUDE_USE_CONFIG_PROFILE=<name> claude` | `claude-use rules add <path> --profile <name>`; or `.claude-use.json`'s `"configProfile"` |
| **A category** | `claude-use profile set <name> --category history=true`; or `claude-use configure <identity>` | `claude --category history=true[,knowledge=false,...]` / `CLAUDE_USE_CATEGORY_OVERRIDE="history=true,knowledge=false"` | `claude-use configure <identity>` run from inside the ruled directory; or `.claude-use.json`'s `"categories"` |
| **An individual entry** | `claude-use profile set <name> --entry "path"=true`; or `claude-use configure <identity> <path>` | `claude --share <path>[,<path>,...]` / `claude --hide <path>[,<path>,...]` / `CLAUDE_USE_ENTRY_OVERRIDE="path=true,otherpath=false"` | `claude-use configure <identity> <path>` run from inside the ruled directory; or `.claude-use.json`'s `"entries"` |
| **Launch flags** | `claude-use profile set <name> [--skip-permissions] [--remote-control]` | `CLAUDE_USE_SKIP_PERMISSIONS=1 claude` / `CLAUDE_USE_REMOTE_CONTROL=1 claude` | rule's inline `"launch"` field; or `.claude-use.json`'s `"launch"` |
| **Ambient-credential guard** | `claude-use identity set <name> --allow-ambient-credential` (per identity, in its `identity.json`) | `CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL=1 claude` | not applicable — this guard is about the active identity's own credential, not a directory context |

The scriptable `claude-use profile set ...` commands exist alongside the interactive picker specifically so this is automatable — CI, setup scripts, or a `.claude-use.json` generator don't need to drive an interactive prompt. `claude-use profile set`'s `--category` and `--entry` options, and `claude`'s own `--category`/`--share`/`--hide` flags, are each repeatable in one invocation (`claude --share <path> --share <path>`, `claude-use profile set work --category history=true --category knowledge=false`) and each also accepts a comma-separated list of values in a single flag — `<key>=<bool>` pairs for `--category`/`--entry`, plain paths for `--share`/`--hide` — the same convention `claude-use profile create --extends <names>` uses for a comma-separated list of profile names, so setting several categories or entries in one launch or on one profile doesn't need one invocation per key. A `--share`/`--hide` path (and the `CLAUDE_USE_ENTRY_OVERRIDE` env var's keys) still needs its `<category>/` prefix like every other entries key (e.g. `claude --share knowledge/skills/commit`) — see [Category-based sharing](#category-based-sharing). `CLAUDE_EXTRA_FLAGS` (below) is a different thing entirely, a passthrough to the real Claude Code binary, not a `claude-use` override: it's a single opaque string, split on whitespace before being appended to the real binary's argv — a flag value that itself needs an embedded space isn't expressible through it.

### Full command list

```
claude-use identity add <name>
claude-use identity use <name>
claude-use identity list
claude-use identity set-default-profile <identity> <profile>
claude-use identity set <name> [--allow-ambient-credential | --no-allow-ambient-credential]

claude-use profile create <name> [--extends <name>,<name>,...]
claude-use profile list
claude-use profile set-default <name>
claude-use profile set <name> --category <cat>=<bool>[,<cat>=<bool>,...]
claude-use profile set <name> --entry "<path>"=<bool>[,"<path>"=<bool>,...]
claude-use profile set <name> [--skip-permissions] [--remote-control]

claude-use rules add <path> [--profile <name>] [--identity <name>]
claude-use rules list
claude-use rules remove <path>

claude-use configure <identity> [path]
claude-use check [path] [--identity <name>]
```

### `claude-use configure`: which file it writes to

`claude-use configure <identity> [path]` always takes an identity as its required first argument, never a profile or a rule directly — a plain `claude-use configure <identity>` with no arguments beyond that is an error, not a default. Two modes:

- **No `path`**: lists that identity's resolved top-level state — the five categories, plus a "edit a specific configuration profile" option — and lets you toggle categories directly or drill into a named profile's own file. This is the only mode that touches `categories`.
- **Given a `path`**: lists that path's children with their resolved state and multi-select toggles, for fine-grained `entries` overrides. This mode never shows or edits categories, only entries under the given path.

In both modes, *where* a toggle is written depends on `$PWD` at invocation time, not on anything passed explicitly, and it never edits a committed, team-shared file directly:

1. If `$PWD` is inside a directory covered by a committed `.claude-use.json` (or `.claude-use.local.json` already exists there), the toggle is written into `.claude-use.local.json` in that same directory — created if it doesn't exist yet — which is the personal-override mechanism [Portable config](#portable-config-claude-usejson) already defines for exactly this case, and is gitignored by convention.
2. Otherwise, if `$PWD` matches a rule in the user's own `~/.claude-use/directory-rules.json` (or would, once one is created for this exact path), the toggle is written there.
3. Otherwise, it's written into the identity's active configuration profile.

`claude-use check` (below) shows you which of the three would apply before you commit to a change, if you're unsure.

### Debugging: `claude-use check`

`claude-use check [path] [--identity <name>]` resolves the full cascade for the given path (default `$PWD`) and identity (default the active one), and prints the result — every entry's resolved state, which layer decided it, and which condition (if any) was evaluated and how — without touching the farm or spawning `claude` at all. This is the primary way to answer "why is X shared/hidden here" without launching a session to find out. For any `history/projects/` glob override in scope, it also flags whenever the pattern's encoded form could plausibly match more than one real path (see [Pattern matching](#pattern-matching-against-claudeprojects)), rather than resolving that ambiguity silently.

It also runs three checks that don't depend on `path` at all, every time, so a review of an identity's isolation doesn't require reasoning through the cascade by hand:

- **Ambient-credential exposure** — the same environment-variable check the launcher itself runs (above), surfaced here too so you can audit an identity without attempting a launch.
- **Credential storage, on macOS** — prints the Keychain service name Claude Code is actually using for the active identity (`security find-generic-password` under the hood), so you can visually confirm two identities really do resolve to two distinct entries rather than trusting the empirical pattern described in [Identities](#identities) blindly.
- **`settings` exposure** — if the `settings` category resolves shared for this identity, and the underlying `settings.json`/`settings.local.json` has a non-empty `env` or `hooks` field, prints how many keys/commands would be shared (names only, never values) so you can review them against [the secrets caveat](#category-based-sharing) yourself, rather than the tool guessing at what looks like a secret.

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
  paths.ts               # CLAUDE_USE_HOME-aware layout paths — every other module resolves ~/.claude-use/... paths through this, never inline
  pathNorm.ts            # rule-path normalisation/ancestor helpers shared across the resolver and directory rules
  exit.ts                # exit code constants
  versionDiscovery.ts     # portable "find the real claude binary" logic
  realPorts.ts            # the real filesystem/spawn/proc/clock/git ports wired into runLauncher by cli.ts (tests wire fakes instead)
  launcher.ts             # runLauncher: thin orchestration over launcher/* below
  launcher/
    ports.ts              # FsPort, SpawnPort, RunPort, ClockPort, ProcPort, LogPort, FarmFs — injected, fakeable
    argv.ts               # parseLauncherArgv — @name consumed only at argv[0]
    guard.ts              # the ambient-credential guard — six guarded vars, empty string counts as unset
    identity.ts           # decideIdentity, decideConfigProfile, loadIdentity
    flags.ts              # resolveLaunchFlags, buildFlagArgs, buildArgv, buildEnv
    extraFlags.ts         # splitExtraFlags for $CLAUDE_EXTRA_FLAGS
    cascade.ts            # loads and assembles the CascadeInput a real launch needs (profiles, directory rules, .claude-use.json)
    lock.ts               # per-identity resync lock
    farm.ts               # farm resync: plan -> build scratch -> reconcile/carry-over -> atomic swap -> crash recovery
    spawn.ts              # spawnClaude — spawns the real binary, propagates its exit code
  identityManager.ts      # `claude-use identity` subcommands
  configProfiles.ts       # `claude-use profile` subcommands (scriptable set/set-default alongside `create`/`list`)
  directoryRules.ts       # `claude-use rules` subcommands
  configure.ts            # `claude-use configure` interactive picker (@clack/prompts)
  check.ts                # `claude-use check` dry-run inspector — cascade resolution, ambient-credential/Keychain/settings-secrets diagnostics — no farm writes, no spawn
  cli/
    parsers.ts            # shared CLI-flag parsing helpers (splitTopLevelCommas, parsePair, repeatable-flag collectors)
  resolve.ts              # public facade re-exporting the resolver below — nothing outside src/resolve/ imports its internals directly
  resolve/
    types.ts              # every resolver type
    match.ts              # canonicaliseEntryKey, compileMatcher, compareSpecificity
    projects.ts            # forward-only ~/.claude/projects/ path encoder — no decoder exists
    conditions.ts          # parseDuration, evaluateWhen, matchBranch
    flatten.ts             # phase one: shallow overwrite per identical canonical key
    decide.ts              # phase two: selectRule, resolveEntry, resolveAll
    extends.ts             # profile extends-chain linearisation (cycle guard + diamond de-dup, post-order emission)
    walk.ts                # directory-ancestor walk + three-source (.claude-use.json / directory-rules.json / .claude-use.local.json) fold
    plan.ts                # materialise-vs-symlink planning
    reconcile.ts           # pure write-through reconciliation planning
  config/
    schema.ts             # Zod schemas: CategoryMap, ConfigProfile, DirectoryRules, GlobalConfig, Identity — single source of truth
    load.ts                # cosmiconfig load(filepath) wrapper (format-flexible parsing) + Zod validation
    classify.ts            # categories.default.json + categories.local.json + real entry names -> Classification
    store.ts               # readJson, writeJsonAtomic, applyPatch — shared by every CLI adapter
    categories.default.json
*.test.ts                  # every module above ships with a colocated test file
schema/                    # published JSON Schemas, generated by `pnpm schema` and stamped with a release-pinned $id at publish time
sea-config.json            # generated by scripts/build.mts, not hand-maintained
package.json / tsconfig.json
scripts/
  build.mts                # esbuild bundle -> node --build-sea=<config> (see Build (Node SEA) below)
  gen-schema.mts            # z.toJSONSchema() per exported schema -> schema/*.schema.json
  gen-schema-core.ts        # shared schema-generation logic used by gen-schema.mts
  stamp-schema-ids.mjs      # rewrites $id to the real version-pinned release URL at publish time
.github/workflows/
  ci.yml                    # typecheck, test, and a `pnpm schema && git diff --exit-code schema/` drift guard
  release.yml               # tag-triggered build (arm64 verified + x64 best-effort) and GitHub Release publish
install.sh                 # places built binaries as `claude` and `claude-use` in ~/.local/bin
```

`schema.ts` models `categories` and `entries` differently despite their identical JSON-object appearance in every example above, because they have opposite key cardinality: `categories` only ever touches the four overridable names in the [category table](#category-based-sharing), so it's a closed `z.strictObject({ runtime: z.boolean().optional(), history: z.boolean().optional(), knowledge: z.boolean().optional(), settings: z.boolean().optional() })` — deliberately omitting `secret` from the shape entirely, so an attempted `secret` key is rejected at parse time rather than relying only on the runtime check described above — while `entries` is genuinely open-ended (any literal or glob path, each required to carry its `<category>/` prefix per the [Category-based sharing](#category-based-sharing) section above) and stays a `z.record(z.string().regex(ENTRY_KEY_RE), EntryValueSchema)`. The closed shape for `categories` also gives editors real key-name autocomplete from the published JSON Schema (the `schema/` directory above), which a record type can't offer.

`ConfigProfile.extends` is a flat `z.array(z.string()).optional()` — a list of other profiles' *names*, resolved by `resolve.ts` loading each named file and walking the resulting graph at runtime. It's correctly **not** a self-referential Zod schema (no `z.lazy()` needed): nothing in `ConfigProfile`'s own shape points back at `ConfigProfile`. Because each profile file validates in isolation, though, Zod has no way to catch a circular `extends` definition (`a` extends `b` extends `a`) — the walker in `resolve.ts` needs its own cycle guard (a visited-set), independent of schema validation.

The `when` condition object's `env` field is `z.record(z.string().min(1), z.string()).optional()` — zero or more named environment-variable checks, ANDed together within the same `when` object exactly like every other condition, rather than a single fixed `{ name, value }` pair (which would need `when` itself to become an array to check more than one variable, a shape nothing else in this design uses).

### Why config file loading uses cosmiconfig's `load()`, never its `search()`

Every config file this tool reads — the global config, named configuration profiles, and each `.claude-use.json`/`.claude-use.local.json` found while walking the directory tree — is loaded with [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig)'s `load(filepath)`. Its `search()` method stops at the first config file found while walking upward; this design needs the opposite — every ancestor collected, shallowest-first — so `resolve.ts` does its own directory walk and calls `load()` at each level it visits, getting cosmiconfig's format flexibility without fighting its traversal semantics. JSON and YAML work with zero extra setup (`js-yaml` is a bundled dependency); JS config files work via native dynamic `import`/`require`. TS config files are real too, but cosmiconfig lists `typescript` as an *optional peer dependency*, not a bundled one — since every config file this tool actually defines is `.json`, that's moot in practice, but it means `.ts` config support isn't something this codebase gets "for free" the way JSON/YAML/JS are, and shipping the compiled Node SEA binary with no `node_modules` at runtime (per [Install](#install)) means a `.ts` config file would fail to load unless `typescript` were bundled into the SEA blob specifically for that purpose — not planned, since nothing this tool ships needs it.

### Why `extends` isn't cosmiconfig's `$import`

cosmiconfig also supports an `$import` directive that deep-merges imported files, later imports winning — close to what `extends` needs. (Its default `mergeImportArrays: true` concatenates arrays — imported items first, then local — rather than fully replacing them; only `mergeImportArrays: false` gives array fields the same "later wins" outright-replacement behaviour objects and primitives already get.) It isn't used for two reasons: it resolves imports by relative file path, not by profile name, so a name-to-path resolution step is needed regardless; and it has no awareness of the entries-beat-categories, most-specific-path-wins rule, which has to be bespoke either way. `resolve.ts` implements one flatten function, reused for both the `extends` chain and the outer cascade, rather than splitting the same conceptual merge across two implementations that could drift apart.

### Resolver mechanics

For each `~/.claude` entry, walk the cascade to a boolean decision. If the decision is uniform for an entire subtree, symlink that directory in one shot. If a deeper path override splits the decision, materialise that directory as a real local directory instead of a symlink and recurse, repeating the check at each level — only directories with an actual split ever get exploded. A conditional entries key is never eligible for the uniform-symlink shortcut, since its decision can only be evaluated per-file.

The pure decision logic — `(entryFacts, cascade, path) => Map<path, boolean>` — takes filesystem/git/env facts as an injected parameter (an entry manifest of path, mtime, and size; a resolved git branch; an env snapshot), rather than reading any of that itself. This is what makes it unit-testable with fake mtimes and a fake branch, per [Testing strategy](#testing-strategy), without touching a real filesystem or `git` — "pure" here means decoupled from I/O via dependency injection, not that no I/O happens anywhere in `resolve.ts`; something still has to walk `~/.claude` and stat its entries to build the manifest this function consumes.

**Materialised directories need a write-through reconciliation step, not just a one-way split.** A directory the real Claude Code binary can create new children in at runtime — `history/projects/` chief among them, since Claude Code creates a new project subdirectory there the first time it sees an unfamiliar working directory — is exactly the kind of directory the tool's own conditional and per-project sharing examples recommend materialising. Once materialised, it stops being a live view of `~/.claude/projects/` and becomes a locally-built directory of symlinks (and further materialised subdirectories) frozen at resync time. Anything Claude Code subsequently writes into it — a brand-new project subdirectory, a new session file inside an existing one — lands as a real, untracked child of that materialised directory, not a symlink back to `~/.claude`: invisible to every other identity, and liable to be misread as stale scaffolding and pruned on a later resync.

The resolver closes this by treating every materialised directory as a two-way sync point, not a one-way snapshot, and does so without ever mutating the live farm in place — consistent with [Directory rules](#directory-rules)'s atomic-swap resync, not in tension with it. On every resync, before building the new scratch tree, the reconciliation pass reads (never writes) each materialised directory still present in the *old* live farm and diffs its actual children against what the previous resync placed there. Any child that's a real file/directory rather than a symlink or a previously-materialised (and still-tracked) subdirectory is new data Claude Code wrote since the last resync — it gets **copied** into the corresponding real path under `~/.claude` (the canonical location, so it's never lost regardless of what happens to the old farm next), and the resolver then makes its usual category/entries decision for that now-canonical entry same as any other, which the new scratch tree reflects like everything else. Once the scratch tree is fully built this way, the atomic rename swaps it in and the old live farm — materialised copies included — is discarded wholesale, the same single swap every other resync already performs; reconciliation never needs its own separate write against the live tree.

The reverse direction matters just as much: a directory materialised because of a split whose cause later disappears (a profile edit removes the entry override that split it, say) collapses back into a single plain symlink on the next resync, rather than being left behind as permanent local scaffolding. This is the same "compare against prior farm state, update only what changed" logic that makes every resync fast in the common case, applied to the one case where a subtree's resolved shape needs to get simpler, not just different.

### Build (Node SEA)

`scripts/build.mts` bundles `src/cli.ts` to a single CJS file with esbuild, writes a `sea-config.json` next to it, then invokes the now-stable single command `node --build-sea=sea-config.json` — this one step handles the bundle copy, signature removal, blob injection, and re-signing that used to require chaining `--experimental-sea-config` with a separate `postject` invocation, and `postject` is not a dependency of this project. On macOS the resulting binary is re-signed with an ad-hoc signature (`codesign --sign -`) afterwards, since blob injection invalidates the original one. `--build-sea` requires Node ≥ v25.5.0, the version it stabilised in; the build script checks the running Node version up front and refuses with a clear error rather than failing deep inside the SEA step if it's older.

One gotcha worth knowing before reaching for this: **Homebrew's macOS Node build has the single-executable-application feature compiled out.** Running the build against a Homebrew-installed Node fails partway through with "Single executable application is disabled" — `scripts/build.mts` detects this specific error and rewrites it into an explanation naming the cause, rather than leaving a contributor to debug an opaque native error. Use a Node binary from a distribution that ships SEA support instead — the official nodejs.org build, or a version manager installing upstream builds (mise, nvm, volta, fnm) — ahead of Homebrew's on `PATH`.

macOS SEA support is tested and verified upstream on **arm64 only** — x64 is explicitly unsupported and skipped in Node core's own test suite. CI builds and publishes the arm64 binary as the verified release artefact; it also attempts an x64 build as a clearly-labelled best-effort convenience (allowed to fail without blocking the release, and published as `claude-use-macos-x64-unverified` when it succeeds), never presented as a supported target.

The published JSON Schemas under `schema/` should self-reference (and, if ever submitted to a public schema catalog, be registered) via a **version-pinned** GitHub Release asset URL — `releases/download/<tag>/<file>` — never a live branch reference, which silently changes underneath every consumer on every push with no way to pin a version. This is deliberately a different URL form from [installing the binaries](#install)'s own `releases/latest/download/...`: the installer *wants* the newest release every time, but a schema an editor references long-term needs to stay stable at whatever version a given config file was written against, not shift underfoot on every future release.

## Testing strategy

`resolve.ts`'s cascade and materialisation logic is exactly the kind of thing that's easy to get subtly wrong, so it gets thorough unit tests before anything else is built on it:

- Each cascade layer overriding the last; path overrides beating their parent category
- Directory rules folding correctly for nested paths, and correctly composing configuration profiles mid-tree
- The `secret` category being unconditionally un-overridable — including an explicit `entries` override attempt targeting a `secret`-category file, not only a bare `categories: { secret: true }` toggle, since the two-phase algorithm's usual "entries beat categories" rule does not apply to this one category
- `~/.claude/backups/` never symlinked in under any configuration, matching `secret`; `~/.claude.json` (a sibling of `~/.claude`, not a descendant) never appearing in the resolver's entry manifest at all, confirming it's structurally excluded rather than merely defaulted off
- Committed `.claude-use.json`/`.claude-use.local.json` files at different tree depths folding shallowest-to-deepest like local directory rules, composing correctly when both apply to the same directory
- Glob patterns matching correctly against literal `~/.claude/projects/` directory names, never attempting to decode a name back to a real path
- Multi-level and diamond `extends` chains resolving correctly, and a circular `extends` definition (`a` → `b` → `a`) being detected and rejected by the walker rather than looping or stack-overflowing
- One identity producing different resolved states under two different configuration profiles, with no leakage between them
- The exact two-phase merge algorithm: a shallow layer's specific entry surviving a later, deeper layer's blanket category flip on the same category; an exact literal key beating a glob from an earlier layer; two globs from different layers resolving to the later layer's value; two globs from the *same* layer resolving by longest-literal-prefix and then source order; two layers setting the identical category resolving to plain last-layer-wins
- Conditional entries with injectable/fake mtimes, a fake resolved branch, and a fake env snapshot (never real filesystem/git/environment state, so tests aren't time-dependent, git-dependent, or slow) — a `newerThan` condition including a fresh file and excluding a stale one under the same glob, a `branch` condition applying only on a matching branch, an `env` condition applying only when the right variable is set, and a conditionally-matched subtree always being materialised rather than symlinked
- A materialised directory reconciling any real (non-symlink) children written since the last resync back into `~/.claude` before re-deciding, and collapsing back into a plain symlink once its split condition no longer holds

`identityManager.ts`, `configProfiles.ts`, `directoryRules.ts`, and `configure.ts` stay thin adapters over `resolve.ts`, so most of their correctness rides on the resolver's own test coverage above. `launcher.ts` carries three separately-testable responsibilities of its own that aren't covered by `resolve.ts`'s purity, and need their own coverage: translating a resolved `Map<path, boolean>` into real filesystem side effects (creating/removing symlinks, materialising/collapsing directories, diffing against the farm's prior state, the per-identity lock and atomic-swap behaviour from [Directory rules](#directory-rules)) against a fake/in-memory filesystem; invoking the real `claude` binary via an injected `spawn` function (argv/env construction, exit-code propagation), never a real subprocess in a unit test; and the ambient-credential guard — given a fake `process.env`, refusing to proceed when any of the six named variables is set and the active identity's `allowAmbientCredential` is unset/false, proceeding when it's true, and proceeding when `CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL=1` is set for that one call regardless of the identity's own setting.

`check.ts`'s three always-on diagnostics get their own tests too, independent of path/cascade resolution: the ambient-credential check against a fake `process.env` (same fixture as `launcher.ts`'s guard, since they share the same detection logic); the settings-secrets advisory against a fake settings.json with populated `env`/`hooks` fields, confirming it reports counts and key names only, never values; and — since Keychain access is real OS state, not something to fake — a manual/integration-only note that the Keychain-name lookup is exercised against a real `security` call in CI on macOS runners, not unit-tested with a mock.

## Development

```bash
pnpm install     # install dependencies
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build       # bundle src/cli.ts with esbuild, then node --build-sea= (see Build (Node SEA) above) — needs Node >= v25.5.0 with SEA support (not Homebrew's build, see the gotcha above)
pnpm schema      # regenerate schema/*.schema.json from src/config/schema.ts; CI fails if this drifts from what's committed
```

Every test run gets `CLAUDE_USE_HOME` set to a throwaway directory by `vitest.config.mts`, and a Vitest setup file (`src/test-setup.ts`) refuses to let any test run at all if that variable is unset or resolves to the real `~/.claude-use` — there is no path by which the test suite can touch a real identity. A farm test that also needs a canonical `~/.claude` to resync against injects its own fake filesystem port rather than touching a real path. Manual, non-test exploration of a locally built binary should follow the same discipline: export `CLAUDE_USE_HOME` (and, if exercising a real farm resync, `CLAUDE_USE_CLAUDE_HOME`) to point at scratch directories, never at your own real identities.

## Contributing

Issues and pull requests are welcome. Please keep the tool itself free of assumptions about any particular organisation, client, or directory layout — it should work the same for anyone. Governance details (contribution sign-off requirements, code of conduct, review process) aren't decided yet and will be added here before the repository is opened up beyond its initial maintainers.

## License

[Apache License 2.0](LICENSE).

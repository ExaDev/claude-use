#!/usr/bin/env sh
set -eu

# Installs the already-built SEA binary as both `claude` and `claude-use` in ~/.local/bin (or $CLAUDE_USE_INSTALL_DIR, if set). One compiled binary backs both names — the entrypoint dispatches on path.basename(process.argv[1]) — so installation just needs two differently-named copies (or hardlinks) of the same executable on PATH. Run `pnpm build` first.

script_dir=$(cd "$(dirname "$0")" && pwd)
built_binary="$script_dir/dist/claude-use-sea"

if [ ! -x "$built_binary" ]; then
  echo "error: $built_binary not found or not executable. Run 'pnpm build' first." >&2
  exit 1
fi

install_dir="${CLAUDE_USE_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir"

for name in claude claude-use; do
  target="$install_dir/$name"
  rm -f "$target"
  if ln "$built_binary" "$target" 2>/dev/null; then
    :
  else
    # Cross-device or otherwise hardlink-incapable filesystem: fall back to a plain copy.
    cp "$built_binary" "$target"
    chmod 755 "$target"
  fi
  echo "installed $target"
done

# Warn if some other `claude` earlier on PATH would shadow this one. `command -v` reports whichever `claude` the current shell would actually run, which is what matters here — not merely whether $install_dir appears in $PATH at all.
resolved_claude=$(command -v claude 2>/dev/null || true)
if [ -n "$resolved_claude" ] && [ "$resolved_claude" != "$install_dir/claude" ]; then
  echo "warning: 'claude' on PATH currently resolves to $resolved_claude, not $install_dir/claude." >&2
  echo "         Put $install_dir ahead of it on PATH (e.g. in your shell profile) so this build is the one that runs." >&2
fi

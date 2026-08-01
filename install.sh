#!/usr/bin/env sh
set -eu

# Downloads the latest GitHub Release SEA binary for the running platform and installs it as both `claude` and `claude-use` in ~/.local/bin (or $CLAUDE_USE_INSTALL_DIR, if set). One compiled binary backs both names — the entrypoint dispatches on path.basename(process.argv[1]) — so installation just needs two differently-named copies (or hardlinks) of the same executable on PATH.
#
# macOS and Linux only: this is a POSIX shell script, and Windows has no `sh` to pipe it into. Windows users get the same two commands via Scoop instead — see the README's Install section.

repo="ExaDev/claude-use"

os=$(uname -s)
arch=$(uname -m)

case "$os" in
  Darwin)
    case "$arch" in
      arm64) asset="claude-use-macos-arm64" ;;
      x86_64) asset="claude-use-macos-x64-unverified" ;;
      *) echo "error: unsupported macOS architecture '$arch'" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "$arch" in
      aarch64 | arm64) asset="claude-use-linux-arm64" ;;
      x86_64) asset="claude-use-linux-x64" ;;
      *) echo "error: unsupported Linux architecture '$arch'" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "error: unsupported platform '$os'. On Windows, use Scoop instead:" >&2
    echo "  scoop bucket add claude-use https://github.com/ExaDev/scoop-claude-use" >&2
    echo "  scoop install claude-use" >&2
    exit 1
    ;;
esac

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

base_url="https://github.com/$repo/releases/latest/download"
echo "Downloading $asset..."
curl -fsSL --retry 3 -o "$tmp_dir/$asset" "$base_url/$asset"
curl -fsSL --retry 3 -o "$tmp_dir/$asset.sha256" "$base_url/$asset.sha256"

expected_sha=$(awk '{print $1}' "$tmp_dir/$asset.sha256")
if command -v shasum >/dev/null 2>&1; then
  actual_sha=$(shasum -a 256 "$tmp_dir/$asset" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  actual_sha=$(sha256sum "$tmp_dir/$asset" | awk '{print $1}')
else
  echo "error: neither shasum nor sha256sum is available to verify the download" >&2
  exit 1
fi
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "error: checksum mismatch for $asset (expected $expected_sha, got $actual_sha)" >&2
  exit 1
fi

chmod +x "$tmp_dir/$asset"

install_dir="${CLAUDE_USE_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir"

for name in claude claude-use; do
  target="$install_dir/$name"
  rm -f "$target"
  if ln "$tmp_dir/$asset" "$target" 2>/dev/null; then
    :
  else
    # Cross-device or otherwise hardlink-incapable filesystem: fall back to a plain copy.
    cp "$tmp_dir/$asset" "$target"
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

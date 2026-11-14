#!/bin/sh
# Type-checks the Rust side (src-tauri) for every system PDForge ships on: Windows, macOS (Apple silicon) and the
# machine you're on. Works on Linux without the Windows or Apple toolchains: a few dependencies compile small C or
# Objective-C files, which `cargo check` doesn't need, so stand-in tools write empty objects for them. CI's real
# builds remain the final check.
#   npm run check:rust
set -e
cd "$(dirname "$0")/../src-tauri"
tools=$(mktemp -d)
trap 'rm -rf "$tools"' EXIT
cat > "$tools/cc" <<'SH'
#!/bin/sh
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  case "$a" in -Fo*) out="${a#-Fo}";; esac
  prev="$a"
done
[ -n "$out" ] && : > "$out"
exit 0
SH
cat > "$tools/lib" <<'SH'
#!/bin/sh
for a in "$@"; do
  case "$a" in /OUT:*|-out:*|-OUT:*) out="${a#*:}";; esac
done
[ -n "$out" ] && printf '!<arch>\n' > "$out"
exit 0
SH
chmod +x "$tools/cc" "$tools/lib"
rustup target add x86_64-pc-windows-msvc aarch64-apple-darwin >/dev/null 2>&1 || true
echo "== this machine"
cargo check --quiet
echo "== Windows"
CC_x86_64_pc_windows_msvc="$tools/cc" AR_x86_64_pc_windows_msvc="$tools/lib" cargo check --quiet --target x86_64-pc-windows-msvc
echo "== macOS (Apple silicon)"
CC_aarch64_apple_darwin="$tools/cc" AR_aarch64_apple_darwin=ar cargo check --quiet --target aarch64-apple-darwin
echo "Rust checks passed."

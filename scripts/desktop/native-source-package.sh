#!/usr/bin/env bash
set -euo pipefail
umask 022

if (( $# != 2 )); then
  echo 'Usage: native-source-package.sh GIT_REF OUTPUT_DIRECTORY' >&2
  exit 2
fi

commit=$(git rev-parse --verify --end-of-options "$1^{commit}")
version=$(git show "$commit:desktop/native/Cargo.toml" | sed -n 's/^version = "\([0-9][0-9.]*\)"$/\1/p')
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
name="AgentSpace-Native-$version-source"
mkdir -p "$2"
output=$(cd "$2" && pwd)
stage=$(mktemp -d)
trap 'rm -r -- "$stage"' EXIT
root="$stage/$name"
mkdir "$root"

git -c tar.umask=0022 archive "$commit" -- LICENSE desktop/native/{Cargo.toml,Cargo.lock,rust-toolchain.toml,build.rs,agent-space.rc,update-release.pub,src} \
  assets/branding/agent-space.ico src/web/public/app-icon-{32,192}.png | tar -xf - -C "$root"

crate="$root/desktop/native"
mv "$crate/Cargo.lock" "$crate/rust-toolchain.toml" "$root/"

# Cargo applies release profiles at the workspace root. Build all three programs by default.
cat > "$root/Cargo.toml" <<'EOF'
[workspace]
members = ["desktop/native"]
resolver = "3"
EOF
awk '/^\[profile\.release\]$/ { profile = 1; print ""; print; next }
     /^\[/ { profile = 0 }
     profile { print }' "$crate/Cargo.toml" >> "$root/Cargo.toml"
awk '/^\[profile\.release\]$/ { profile = 1; next }
     /^\[/ { profile = 0 }
     /^default = \["desktop"\]$/ { print "default = [\"desktop\", \"official-plugins\"]"; next }
     !profile { print }' "$crate/Cargo.toml" > "$stage/Cargo.toml"
mv "$stage/Cargo.toml" "$crate/Cargo.toml"

cat > "$root/README.md" <<'EOF'
# Agent Space Rust Adapter

Run this from the extracted directory.

```sh
cargo build --release --locked
```

Cargo writes `agent-space-native`, `agent-space-adapter-codex` and
`agent-space-adapter-dsh` to `target/release`. The build uses Rust and the
platform's native compiler and linker. Cargo fetches the locked dependencies
from crates.io on the first build.

The gateway runs Codex and DSH as plugin processes. Install their packaged
directories with `agent-space-native --adapter install <directory>` before
starting a gateway built from source.

- Linux builds use a C compiler and linker for native dependencies. The tray uses the desktop D-Bus session.
- Windows desktop builds use the MSVC Rust toolchain and Windows SDK.
- macOS builds use Xcode command-line tools.
  Run `MACOSX_DEPLOYMENT_TARGET=14.0 cargo build --release --locked` for the release settings.

To build the headless adapter and both plugins without system tray support,
run `cargo build --release --locked --no-default-features --features official-plugins`.
EOF

# Normalize metadata so builds of the same tagged source produce the same archive.
epoch=$(git show -s --format=%ct "$commit")
tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner \
  -C "$stage" -cf - "$name" | gzip -n > "$output/$name.tar.gz"
printf '%s\n' "$output/$name.tar.gz"

#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock="$repo_root/core/houston-core/ghostty-vt.lock"
cache="$repo_root/core/target/ghostty-vt"
vendor="$repo_root/ui/src/renderer/src/ghostty/vendor/ghostty-vt.wasm"

lock_get() {
  local key="$1" value
  value="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\"\(.*\)\"[[:space:]]*$/\1/p" "$lock")"
  if [[ -z "$value" ]]; then
    echo "build-ghostty-vt-wasm: $lock has no key '$key'" >&2
    exit 1
  fi
  printf '%s' "$value"
}

revision="$(lock_get revision)"
source_url="$(lock_get source_url)"
source_sha256="$(lock_get source_sha256)"
version_string="$(lock_get lib_version_string)"
zig_version="$(lock_get zig_version)"
zig_url_prefix="$(lock_get zig_url_prefix)"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) slug="x86_64-linux" ;;
  Linux-aarch64) slug="aarch64-linux" ;;
  Darwin-arm64) slug="aarch64-macos" ;;
  Darwin-x86_64) slug="x86_64-macos" ;;
  *) echo "no pinned Zig for $(uname -s)-$(uname -m); extend ghostty-vt.lock" >&2; exit 1 ;;
esac
zig_sha256="$(lock_get "zig_sha256_${slug}")"

mkdir -p "$cache"

src="${HOUSTON_GHOSTTY_VT_SRC:-$cache/src-$revision}"
if [[ ! -e "$src/.houston-extracted" && -z "${HOUSTON_GHOSTTY_VT_SRC:-}" ]]; then
  tarball="$cache/ghostty-$revision.tar.gz"
  [[ -f "$tarball" ]] || curl -sSL --fail -o "$tarball" "$source_url"
  got="$(sha256sum "$tarball" | cut -d' ' -f1)"
  if [[ "$got" != "$source_sha256" ]]; then
    echo "libghostty-vt source checksum mismatch for $source_url" >&2
    echo "  expected $source_sha256" >&2
    echo "  got      $got" >&2
    exit 1
  fi
  mkdir -p "$src"
  tar -xzf "$tarball" --strip-components=1 -C "$src"
  touch "$src/.houston-extracted"
fi

cp "$repo_root/core/houston-core/ghostty-vt/houston_snapshot.zig" \
   "$src/src/terminal/c/houston_snapshot.zig"
if [[ ! -e "$src/.houston-patched" ]]; then
  patch -p1 -F 0 --no-backup-if-mismatch -d "$src" \
    -i "$repo_root/core/houston-core/ghostty-patches/0001-houston-snapshot-exports.patch"
  touch "$src/.houston-patched"
fi

zig="${HOUSTON_ZIG:-$cache/zig-$slug-$zig_version/zig}"
if [[ ! -x "$zig" ]]; then
  archive="$cache/zig-$slug-$zig_version.tar.xz"
  [[ -f "$archive" ]] || curl -sSL --fail -o "$archive" "$zig_url_prefix$slug-$zig_version.tar.xz"
  got="$(sha256sum "$archive" | cut -d' ' -f1)"
  if [[ "$got" != "$zig_sha256" ]]; then
    echo "zig $zig_version checksum mismatch for $slug" >&2
    echo "  expected $zig_sha256" >&2
    echo "  got      $got" >&2
    exit 1
  fi
  mkdir -p "$cache/zig-$slug-$zig_version"
  tar -xJf "$archive" --strip-components=1 -C "$cache/zig-$slug-$zig_version"
fi

prefix="$cache/wasm-$revision"
git_ceiling="$(cd "$(dirname "$src")" && pwd -P)"
( cd "$src" && GIT_CEILING_DIRECTORIES="$git_ceiling" nice -n 19 "$zig" build -Demit-lib-vt \
    -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall -Dstrip=true \
    "-Dlib-version-string=$version_string" -p "$prefix" )

cp "$prefix/bin/ghostty-vt.wasm" "$vendor"
echo "wrote $vendor ($(wc -c <"$vendor") bytes, revision $revision)"

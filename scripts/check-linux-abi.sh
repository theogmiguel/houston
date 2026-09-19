#!/usr/bin/env bash
set -euo pipefail

# The distribution floor: a deb built on Ubuntu 22.04 keeps its promise to
# install there only while every binary asks glibc for no symbol newer than
# jammy's 2.35 -- a newer symbol shows up here and nowhere else.

# LC_ALL=C is load-bearing: readelf's headings and Machine: line are
# gettext-translated, and a localized run would parse as "nothing required".
export LC_ALL=C

MAX_GLIBC=2.35

usage() {
  echo "usage: scripts/check-linux-abi.sh <deb-path> <arch>" >&2
  echo "  arch: x86_64|amd64 or aarch64|arm64" >&2
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || { usage; exit 1; }

deb="$1"
arch="$2"

case "$arch" in
  x86_64|amd64) elf_machine="Advanced Micro Devices X86-64" ;;
  aarch64|arm64) elf_machine="AArch64" ;;
  *) fail "unknown arch '$arch'. Accepted: x86_64, amd64, aarch64, arm64" ;;
esac

command -v dpkg-deb >/dev/null 2>&1 \
  || fail "dpkg-deb is not on PATH. This gate extracts the deb with it; run it on a Debian-family host"
command -v readelf >/dev/null 2>&1 \
  || fail "readelf is not on PATH. This gate reads ELF headers and version requirements; install binutils"

[ -f "$deb" ] || fail "no deb at '$deb'"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

dpkg-deb -x "$deb" "$workdir" >/dev/null \
  || fail "dpkg-deb -x failed on '$deb' -- it is not a readable .deb"

echo "check-linux-abi: $deb (arch $arch, glibc cap $MAX_GLIBC)"

status=0

for name in houston houston-core houston-supervisor tr-helper; do
  bin="$workdir/usr/bin/$name"
  if [ ! -f "$bin" ]; then
    echo "FAIL: $deb does not carry /usr/bin/$name (nothing extracted at $bin)" >&2
    status=1
    continue
  fi

  machine="$(readelf -h "$bin" | sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p')"
  if [ -z "$machine" ]; then
    echo "FAIL: readelf -h printed no Machine: line for /usr/bin/$name in $deb -- refusing to pass an ELF header this gate cannot read" >&2
    status=1
    continue
  fi
  if [ "$machine" != "$elf_machine" ]; then
    echo "FAIL: /usr/bin/$name in $deb is ELF machine '$machine', but this is the $arch artifact and expected '$elf_machine'. The wrong runner built it, or the deb was mislabeled" >&2
    status=1
    continue
  fi

  sections="$(readelf -S "$bin")" || {
    echo "FAIL: readelf -S failed on /usr/bin/$name in $deb" >&2
    status=1
    continue
  }
  if ! grep -q '\.gnu\.version_r' <<<"$sections"; then
    echo "ok: /usr/bin/$name ($machine) has no .gnu.version_r -- it requires no versioned GLIBC symbol"
    continue
  fi

  required="$(readelf --version-info "$bin" \
    | sed -n '/Version needs section/,/Version definition section/p' \
    | sed -n 's/.*Name: \(GLIBC_[0-9.]*\).*/\1/p' \
    | sed 's/^GLIBC_//' \
    | sort -Vu | tail -n1)"
  if [ -z "$required" ]; then
    echo "FAIL: /usr/bin/$name in $deb needs .gnu.version_r but readelf --version-info listed no GLIBC name -- the output shape changed, and this gate refuses to pass a requirement it cannot read" >&2
    status=1
    continue
  fi

  highest="$(printf '%s\n%s\n' "$MAX_GLIBC" "$required" | sort -V | tail -n1)"
  if [ "$highest" != "$MAX_GLIBC" ]; then
    echo "FAIL: /usr/bin/$name requires GLIBC_$required, above the GLIBC_$MAX_GLIBC cap this artifact promises -- built on a newer Ubuntu than 22.04, or a dependency adopted a newer symbol. Symbol versions found:" >&2
    readelf --version-info "$bin" \
      | sed -n '/Version needs section/,/Version definition section/p' \
      | sed -n 's/.*Name: \(GLIBC_[0-9.]*\).*/      \1/p' \
      | sort -Vu | tail -n5 >&2
    status=1
    continue
  fi

  echo "ok: /usr/bin/$name ($machine) requires GLIBC up to $required (cap $MAX_GLIBC)"
done

exit "$status"

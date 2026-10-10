#!/usr/bin/env bash

# The Windows installer carries the Linux daemon that WSL environments install into a
# distro. tauri.windows.conf.json bundles src-tauri/wsl/; every file staged there must
# be one of the three x86-64 ELF binaries. HOUSTON_WSL_BUNDLE_REQUIRED=1 requires all three.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

conf="src-tauri/tauri.windows.conf.json"
stage="src-tauri/wsl"
names=(houston-core tr-helper houston-supervisor)
expected_resources='"resources":["resources/third-party-licenses.json","wsl/"]'
fail=0

if [ ! -f "$conf" ]; then
  echo "FAIL: $conf is missing; the Windows installer would ship no Linux daemon." >&2
  exit 1
fi
if tr -d ' \t\r\n' < "$conf" | grep -qF "$expected_resources"; then
  echo "ok: $conf bundles wsl/ (wsl/houston-core, wsl/tr-helper, wsl/houston-supervisor)"
else
  echo "FAIL: $conf must set bundle.resources to" >&2
  echo "      [\"resources/third-party-licenses.json\", \"wsl/\"]" >&2
  echo "      (a platform file replaces the base list, so the licence file is listed again)." >&2
  fail=1
fi

# ELF magic, 64-bit class, little-endian, and e_machine 0x3e (x86-64) at offset 18.
is_x86_64_elf() {
  local header
  header="$(od -An -tx1 -N20 "$1" | tr -d ' \n')"
  [ "${header:0:8}" = "7f454c46" ] && [ "${header:8:4}" = "0201" ] && [ "${header:36:4}" = "3e00" ]
}

staged=()
if [ -d "$stage" ]; then
  while IFS= read -r -d '' file; do
    staged+=("${file#"$stage"/}")
  done < <(find "$stage" -mindepth 1 -print0)
fi

for entry in "${staged[@]+"${staged[@]}"}"; do
  case " ${names[*]} " in
    *" $entry "*) ;;
    *)
      echo "FAIL: $stage/$entry would ship in the installer; only ${names[*]} belong there." >&2
      fail=1
      ;;
  esac
done

if [ "${#staged[@]}" -eq 0 ] && [ "${HOUSTON_WSL_BUNDLE_REQUIRED:-0}" != "1" ]; then
  echo "skip: nothing staged in $stage (a development build); HOUSTON_WSL_BUNDLE_REQUIRED=1 requires it"
  exit "$fail"
fi

for name in "${names[@]}"; do
  file="$stage/$name"
  if [ ! -f "$file" ]; then
    echo "FAIL: $file is missing; stage ${names[*]} built for x86_64-unknown-linux-gnu" >&2
    echo "      (scripts/build-app.ps1 copies them from HOUSTON_WSL_LINUX_BIN_DIR)." >&2
    fail=1
  elif is_x86_64_elf "$file"; then
    echo "ok: $file is an x86-64 ELF executable"
  else
    echo "FAIL: $file is not an x86-64 ELF (header $(od -An -tx1 -N20 "$file" | tr -d '\n'));" >&2
    echo "      expected 7f 45 4c 46 02 01 ... with e_machine 3e 00 at offset 18." >&2
    fail=1
  fi
done

exit "$fail"

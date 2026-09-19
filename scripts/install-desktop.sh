#!/usr/bin/env bash

set -euo pipefail

# The invariant this installer maintains: the installed app executes only files
# under ~/.local/lib/houston/, never a path inside this repo. The grep at the
# end fails loudly and names the file if that coupling regresses.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVG="$ROOT/ui/resources/icon.svg"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor"
LIBDIR="$HOME/.local/lib/houston"
APP_SRC="$ROOT/src-tauri/target/release/houston"
HELPER_NAME="tr-helper"
HELPER_SRC="$ROOT/src-tauri/target/release/$HELPER_NAME"
CORE_NAME="houston-core"
CORE_SRC="$ROOT/src-tauri/target/release/$CORE_NAME"
SUPERVISOR_NAME="houston-supervisor"
SUPERVISOR_SRC="$ROOT/src-tauri/target/release/$SUPERVISOR_NAME"

[ -f "$SVG" ] || { echo "icon source missing at $SVG" >&2; exit 1; }
[ -x "$APP_SRC" ] || { echo "app binary missing at $APP_SRC — run: ./scripts/build-app.sh" >&2; exit 1; }

"$ROOT/scripts/check-renderer-fresh.sh" >/dev/null || {
  echo "refusing to install: the built renderer is stale against the wire protocol." >&2
  echo "Run ./scripts/check-renderer-fresh.sh to see which side is behind, then rebuild:" >&2
  echo "  ./scripts/build-app.sh" >&2
  exit 1
}

"$ROOT/scripts/check-binary-fresh.sh" >/dev/null || {
  echo "refusing to install: the app binary is stale (details above)." >&2
  exit 1
}

mkdir -p "$LIBDIR"
cp "$APP_SRC" "$LIBDIR/houston"
chmod +x "$LIBDIR/houston"

if [ -x "$HELPER_SRC" ]; then
  cp "$HELPER_SRC" "$LIBDIR/$HELPER_NAME"
  chmod +x "$LIBDIR/$HELPER_NAME"
else
  echo "warning: $HELPER_SRC missing — hooks and swarm CLIs will exec the app" >&2
  echo "         binary instead (slower, but correct). Run ./scripts/build-app.sh." >&2
fi

[ -x "$CORE_SRC" ] || { echo "daemon sidecar missing at $CORE_SRC — run: ./scripts/build-app.sh" >&2; exit 1; }
cp "$CORE_SRC" "$LIBDIR/$CORE_NAME"
chmod +x "$LIBDIR/$CORE_NAME"

[ -x "$SUPERVISOR_SRC" ] || { echo "supervisor sidecar missing at $SUPERVISOR_SRC — run: ./scripts/build-app.sh" >&2; exit 1; }
cp "$SUPERVISOR_SRC" "$LIBDIR/$SUPERVISOR_NAME"
chmod +x "$LIBDIR/$SUPERVISOR_NAME"

cp "$ROOT/scripts/start.sh" "$LIBDIR/start.sh"
chmod +x "$LIBDIR/start.sh"

cat >"$LIBDIR/launch.sh" <<LAUNCH_EOF
#!/usr/bin/env bash
export TR_APP="$LIBDIR/houston"
exec "$LIBDIR/start.sh" "\$@"
LAUNCH_EOF
chmod +x "$LIBDIR/launch.sh"

mkdir -p "$APPS"
cat >"$APPS/houston.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Houston
Comment=Mission control for CLI coding agents
Exec=$LIBDIR/launch.sh
Terminal=false
Icon=houston
Categories=Development;
StartupWMClass=houston
EOF

repo_leak=0
for f in "$LIBDIR/launch.sh" "$LIBDIR/start.sh" "$APPS/houston.desktop"; do
  hit="$(grep -n -F "$ROOT" "$f" || true)"
  if [ -n "$hit" ]; then
    echo "INVARIANT VIOLATION: $f references the repo path ($ROOT):" >&2
    echo "$hit" >&2
    repo_leak=1
  fi
done
if [ "$repo_leak" -ne 0 ]; then
  echo "refusing to finish install: the installed app must execute only files under $LIBDIR" >&2
  exit 1
fi

app_size="$(du -sh "$LIBDIR/houston" | cut -f1)"
start_size="$(du -sh "$LIBDIR/start.sh" | cut -f1)"
echo "installed: $LIBDIR/houston ($app_size) <- $APP_SRC"
echo "installed: $LIBDIR/$CORE_NAME <- $CORE_SRC"
echo "installed: $LIBDIR/$SUPERVISOR_NAME <- $SUPERVISOR_SRC"
echo "installed: $LIBDIR/start.sh ($start_size) <- $ROOT/scripts/start.sh"
echo "installed: $LIBDIR/launch.sh (wrapper, sets TR_APP, execs $LIBDIR/start.sh)"

for size in 48 64 128 256 512; do
  src="$ROOT/ui/resources/icons/hicolor/${size}x${size}.png"
  [ -f "$src" ] || {
    echo "icon render missing at $src -- run: cd ui && bun run icons" >&2
    exit 1
  }
  mkdir -p "$ICONS/${size}x${size}/apps"
  cp "$src" "$ICONS/${size}x${size}/apps/houston.png"
done

if command -v gtk-update-icon-cache >/dev/null; then
  gtk-update-icon-cache -f -t "$ICONS" >/dev/null 2>&1 || true
fi
if command -v update-desktop-database >/dev/null; then
  update-desktop-database "$APPS" >/dev/null 2>&1 || true
fi

echo "installed: $APPS/houston.desktop"
echo "installed: $ICONS/{48,64,128,256,512}x*/apps/houston.png"

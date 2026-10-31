#!/usr/bin/env bash

set -euo pipefail

# The invariant this installer maintains: the installed app executes only files
# under ~/.local/lib/houston/, never a path inside this repo. The grep at the
# end fails loudly and names the file if that coupling regresses.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS="$HOME/.local/share/applications"
LIBDIR="$HOME/.local/lib/houston"
APP_SRC="$ROOT/src-tauri/target/release/houston"

[ -x "$APP_SRC" ] || { echo "app binary missing at $APP_SRC — run: ./scripts/build-app.sh" >&2; exit 1; }

"$ROOT/scripts/check-binary-fresh.sh" >/dev/null || {
  echo "refusing to install: the app binary is stale (details above)." >&2
  exit 1
}

mkdir -p "$LIBDIR"
cp "$APP_SRC" "$LIBDIR/houston"
chmod +x "$LIBDIR/houston"

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
Exec=$LIBDIR/launch.sh %f
Terminal=false
Icon=houston
Categories=Development;
StartupWMClass=houston
MimeType=application/x-houston-transfer;
EOF

# Workspace transfer files open with Houston, which shows the import dialog.
MIME="$HOME/.local/share/mime"
mkdir -p "$MIME/packages"
cat >"$MIME/packages/houston-transfer.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-houston-transfer">
    <comment>Houston workspace transfer</comment>
    <glob pattern="*.houston-transfer"/>
  </mime-type>
</mime-info>
EOF
if command -v update-mime-database >/dev/null; then
  update-mime-database "$MIME" >/dev/null 2>&1 || true
fi

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
echo "installed: $LIBDIR/start.sh ($start_size) <- $ROOT/scripts/start.sh"
echo "installed: $LIBDIR/launch.sh (wrapper, sets TR_APP, execs $LIBDIR/start.sh)"

if command -v update-desktop-database >/dev/null; then
  update-desktop-database "$APPS" >/dev/null 2>&1 || true
fi

echo "installed: $APPS/houston.desktop"
echo "installed: $MIME/packages/houston-transfer.xml"

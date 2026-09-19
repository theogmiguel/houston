#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ $# -eq 0 ]; then
  echo "usage: p5-harness/measure.sh '<leg command>' ['<leg command>' ...]" >&2
  exit 2
fi

if [ ! -f p5-harness/dist/index.html ]; then
  echo "p5-harness/dist is not built — run:" >&2
  echo "  bunx vite build --config p5-harness/vite.config.mts" >&2
  exit 2
fi

# Run every leg through THIS script, never against `dist/` directly: `dist/` is
# rebuilt by other agents while a leg reads it, and a half-written bundle once
# reported 90 differing bitmaps a clean re-run put at 0 — a false regression.
SNAP="$(mktemp -d "${TMPDIR:-/tmp}/p5-snap-XXXXXX")"
cp -r p5-harness/dist/. "$SNAP/"

PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$SNAP" >/dev/null 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  rm -rf "$SNAP"
}
trap cleanup EXIT

for _ in $(seq 1 50); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/index.html"; then break; fi
  sleep 0.1
done
if ! curl -sf -o /dev/null "http://127.0.0.1:$PORT/index.html"; then
  echo "snapshot server on port $PORT never answered" >&2
  exit 2
fi

echo "── measuring against frozen snapshot (port $PORT); dist/ is free to be rebuilt ──"

status=0
for leg in "$@"; do
  echo
  echo "=== $leg ==="
  if ! env HARNESS_URL="http://127.0.0.1:$PORT/?freeze" bash -c "$leg"; then
    echo "LEG FAILED: $leg" >&2
    status=1
  fi
done

exit "$status"

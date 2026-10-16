#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT="${PORT:-3000}"
URL="http://127.0.0.1:${PORT}"

if ! curl -fsS "${URL}/api/health" >/dev/null 2>&1; then
  echo "🚀 Starting Vanaras Desktop Engine on ${URL}..."
  nohup node "$DIR/ui/server.mjs" >/tmp/vanaras-server.log 2>&1 &
  for _ in {1..25}; do
    if curl -fsS "${URL}/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
else
  echo "✅ Vanaras Desktop Engine is already running on ${URL}"
fi

open "$URL"

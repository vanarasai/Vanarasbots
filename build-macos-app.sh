#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "${SCRIPT_DIR}/Vanaras.app/Contents/MacOS"
clang -fobjc-arc -DVANARAS_REPO_ROOT="\"${SCRIPT_DIR}\"" "${SCRIPT_DIR}/macos/main.m" -o "${SCRIPT_DIR}/Vanaras.app/Contents/MacOS/Vanaras" -framework Cocoa -framework WebKit
echo "Built native macOS app: ${SCRIPT_DIR}/Vanaras.app"

#!/bin/bash
# Run the podcast generator with the virtual environment.
# Usage: ./run.sh "Your Topic Here" [output_filename.wav]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TOPIC="${1:-LLM 101}"
FILENAME="${2:-episode.wav}"

if [ ! -d ".venv" ]; then
    echo "Virtual environment not found. Running setup first..."
    ./setup.sh
fi

source .venv/bin/activate
python3 app.py "$TOPIC"
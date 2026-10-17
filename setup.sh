#!/bin/bash
# Create virtual environment and install dependencies.
# Usage: ./setup.sh  (or: bash setup.sh)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🔧 Setting up Vanaras Podcast Generator..."

# Create venv if missing
if [ ! -d ".venv" ]; then
    echo "📦 Creating virtual environment (.venv)..."
    python3 -m venv .venv
    echo "✓ Virtual environment created"
else
    echo "✓ Virtual environment already exists"
fi

# Activate and install dependencies
echo "📥 Installing dependencies..."
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt

echo "✅ Setup complete!"
echo ""
echo "To run the podcast generator:"
echo "  source .venv/bin/activate"
echo "  python3 app.py \"Your Topic\" ./output 10 episode.wav"
echo ""
echo "Or simply:"
echo "  ./run.sh \"Your Topic\""
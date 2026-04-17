#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

echo "== Autoscreenshot Dev =="
echo "Project: $ROOT_DIR"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # Double-clicked .command sessions do not always load shell init files.
  source "$NVM_DIR/nvm.sh"
fi

if command -v nvm >/dev/null 2>&1; then
  if ! nvm use 20 >/dev/null 2>&1; then
    echo "Node 20 is required but was not found in nvm."
    echo "Install it with: nvm install 20"
    exit 1
  fi
elif [ -x "$HOME/.nvm/versions/node/v20.19.3/bin/node" ]; then
  export PATH="$HOME/.nvm/versions/node/v20.19.3/bin:$PATH"
else
  echo "Node 20 is required for this project."
  echo "Current node: $(command -v node >/dev/null 2>&1 && node -v || echo 'not found')"
  echo "Install it with nvm, for example: nvm install 20"
  exit 1
fi

echo "Node: $(node -v)"
echo "npm:  $(npm -v)"

if [ ! -d node_modules ]; then
  echo "node_modules not found, running npm ci..."
  npm ci
fi

echo
echo "Starting dev servers..."
echo "Web: http://127.0.0.1:5173"
echo "API: http://127.0.0.1:8787"
echo "Stop with Ctrl+C or close this Terminal window."
echo

exec npm run dev

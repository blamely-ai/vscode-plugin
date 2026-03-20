#!/usr/bin/env sh
# Create a new Blamely VSIX package.
# Usage: ./create-vsix.sh

set -e
cd "$(dirname "$0")"

echo "Building extension..."
npm run compile

echo "Packaging VSIX..."
npx @vscode/vsce package --no-dependencies

VSIX=$(ls -t Blamely-*.vsix 2>/dev/null | head -1)
if [ -n "$VSIX" ]; then
  echo "Done: $VSIX"
  ls -la "$VSIX"
else
  echo "Error: No .vsix file produced"
  exit 1
fi

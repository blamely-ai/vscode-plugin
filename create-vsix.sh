#!/usr/bin/env sh
# Create a new Blamely VSIX package.
# Usage: ./create-vsix.sh

set -e
cd "$(dirname "$0")"

echo "Building VSIX: clean out/, release compile (no sourcemaps), obfuscate JS, package via .vscodeignore (no TypeScript in bundle)."
npm run vsix

VSIX=$(ls -t *.vsix 2>/dev/null | head -1)
if [ -n "$VSIX" ]; then
  echo "Done: $VSIX"
  ls -la "$VSIX"
else
  echo "Error: No .vsix file produced"
  exit 1
fi

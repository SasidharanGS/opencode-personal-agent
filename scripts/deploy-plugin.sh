#!/usr/bin/env bash
# Deploy plugin source to ~/.config/opencode/plugins/
set -e

WORKTREE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/.config/opencode/plugins"

mkdir -p "$DEST/personal-agent/clients"

cp "$WORKTREE/src/bootstrap.ts"         "$DEST/personal-agent/bootstrap.ts"
cp "$WORKTREE/src/types.ts"             "$DEST/personal-agent/types.ts"
cp "$WORKTREE/src/clients/joplin.ts"    "$DEST/personal-agent/clients/joplin.ts"
cp "$WORKTREE/src/clients/memory.ts"    "$DEST/personal-agent/clients/memory.ts"

# Main entry file with corrected imports
sed 's|"./bootstrap.js"|"./personal-agent/bootstrap.js"|g;
     s|"./clients/joplin.js"|"./personal-agent/clients/joplin.js"|g;
     s|"./clients/memory.js"|"./personal-agent/clients/memory.js"|g;
     s|"./types.js"|"./personal-agent/types.js"|g' \
  "$WORKTREE/src/plugin.ts" > "$DEST/personal-agent.ts"

echo "Deployed personal-agent plugin to $DEST"
echo "Restart opencode to load."

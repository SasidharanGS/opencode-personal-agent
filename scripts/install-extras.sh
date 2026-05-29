#!/usr/bin/env bash
#
# Install opencode-personal-agent's skills and slash commands.
#
# The plugin itself is loaded by opencode via the `plugin` array in
# opencode.jsonc (e.g. "opencode-personal-agent@git+https://..."), so we
# only need to install the side-files here:
#
#   ~/.config/opencode/skills/<name>/SKILL.md      (one dir per skill)
#   ~/.config/opencode/commands/<name>.md          (one file per slash command)
#
# This script also cleans up artefacts from earlier file-drop install
# models: a stale personal-agent.js bundle, a personal-agent directory
# symlink, or a raw personal-agent.ts file in ~/.config/opencode/plugins/.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OPENCODE_CONFIG="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
PLUGINS_DIR="$OPENCODE_CONFIG/plugins"
SKILLS_DEST="$OPENCODE_CONFIG/skills"
COMMANDS_DEST="$OPENCODE_CONFIG/commands"

mkdir -p "$SKILLS_DEST" "$COMMANDS_DEST"

# Clean up stale file-drop install artefacts so opencode doesn't load the
# plugin twice (once via the config array, once from the plugins dir).
for stale in \
  "$PLUGINS_DIR/personal-agent.js" \
  "$PLUGINS_DIR/personal-agent.ts" \
  "$PLUGINS_DIR/personal-agent"; do
  if [ -e "$stale" ] || [ -L "$stale" ]; then
    echo "==> removing stale $stale"
    rm -rf "$stale"
  fi
done

# Install every skill in skills/ as its own directory (preserves SKILL.md + assets).
echo "==> installing skills"
for skill_dir in "$REPO/skills/"*/; do
  [ -d "$skill_dir" ] || continue
  name="$(basename "$skill_dir")"
  rm -rf "$SKILLS_DEST/$name"
  mkdir -p "$SKILLS_DEST/$name"
  cp -R "$skill_dir." "$SKILLS_DEST/$name/"
  echo "    + skill: $name"
done

# Install every slash command in commands/.
echo "==> installing commands"
for cmd in "$REPO/commands/"*.md; do
  [ -f "$cmd" ] || continue
  name="$(basename "$cmd")"
  cp "$cmd" "$COMMANDS_DEST/$name"
  echo "    + command: ${name%.md}"
done

echo
echo "Done. Add this to your ~/.config/opencode/opencode.jsonc 'plugin' array if you haven't already:"
echo "    \"opencode-personal-agent@git+https://github.com/SasidharanGS/opencode-personal-agent.git\""
echo
echo "Then restart opencode."

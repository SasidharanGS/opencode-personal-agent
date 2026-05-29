#!/usr/bin/env bash
#
# Build and deploy the personal-agent opencode plugin.
#
# Layout it produces:
#   ~/.config/opencode/plugins/personal-agent.js   (bundled ESM, loaded by opencode)
#   ~/.config/opencode/skills/<name>/SKILL.md      (one dir per skill)
#   ~/.config/opencode/commands/<name>.md          (one file per slash command)
#
# Removes any stale ~/.config/opencode/plugins/personal-agent/ directory
# (or symlink) left over from earlier raw-.ts install models.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OPENCODE_CONFIG="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
PLUGINS_DEST="$OPENCODE_CONFIG/plugins"
SKILLS_DEST="$OPENCODE_CONFIG/skills"
COMMANDS_DEST="$OPENCODE_CONFIG/commands"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required to build the plugin (https://bun.sh)" >&2
  exit 1
fi

mkdir -p "$PLUGINS_DEST" "$SKILLS_DEST" "$COMMANDS_DEST"

# 1) Build the bundle.
echo "==> building dist/plugin.js"
cd "$REPO"
bun build src/plugin.ts --outdir dist --format esm --target node >/dev/null

# 2) Remove stale directory/symlink from earlier install models.
if [ -e "$PLUGINS_DEST/personal-agent" ] || [ -L "$PLUGINS_DEST/personal-agent" ]; then
  echo "==> removing stale $PLUGINS_DEST/personal-agent"
  rm -rf "$PLUGINS_DEST/personal-agent"
fi
if [ -e "$PLUGINS_DEST/personal-agent.ts" ]; then
  echo "==> removing stale $PLUGINS_DEST/personal-agent.ts"
  rm -f "$PLUGINS_DEST/personal-agent.ts"
fi

# 3) Install the bundled plugin.
echo "==> installing plugin -> $PLUGINS_DEST/personal-agent.js"
cp "$REPO/dist/plugin.js" "$PLUGINS_DEST/personal-agent.js"

# 4) Install every skill in skills/ as its own directory (preserves SKILL.md + assets).
echo "==> installing skills"
for skill_dir in "$REPO/skills/"*/; do
  [ -d "$skill_dir" ] || continue
  name="$(basename "$skill_dir")"
  rm -rf "$SKILLS_DEST/$name"
  mkdir -p "$SKILLS_DEST/$name"
  cp -R "$skill_dir." "$SKILLS_DEST/$name/"
  echo "    + skill: $name"
done

# 5) Install every slash command in commands/.
echo "==> installing commands"
for cmd in "$REPO/commands/"*.md; do
  [ -f "$cmd" ] || continue
  name="$(basename "$cmd")"
  cp "$cmd" "$COMMANDS_DEST/$name"
  echo "    + command: ${name%.md}"
done

echo
echo "Done. Restart opencode to load."

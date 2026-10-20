#!/usr/bin/env bash
# Install the repo's git hooks. Idempotent; safe to re-run.
#
# .git/hooks is not tracked, so every clone has to do this once. The Claude Code
# PreToolUse wiring in .claude/settings.json IS tracked and needs no install,
# which is why the same script backs both: an agent is covered immediately, a
# human after one command.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HOOK_DIR="$ROOT/.git/hooks"
mkdir -p "$HOOK_DIR"

chmod +x "$ROOT/scripts/hooks/privacy-precommit.sh"

TARGET="$HOOK_DIR/pre-commit"
if [ -e "$TARGET" ] && ! grep -q 'privacy-precommit' "$TARGET" 2>/dev/null; then
  cp "$TARGET" "$TARGET.local"
  echo "kept your existing pre-commit as .git/hooks/pre-commit.local (it still runs)"
fi

cat > "$TARGET" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
[ -x "$ROOT/.git/hooks/pre-commit.local" ] && "$ROOT/.git/hooks/pre-commit.local"
exec "$ROOT/scripts/hooks/privacy-precommit.sh"
HOOK
chmod +x "$TARGET"

echo "installed .git/hooks/pre-commit -> scripts/hooks/privacy-precommit.sh"

#!/usr/bin/env bash
#
# Privacy pre-commit guard for ppv2.
#
# Blocks the two leak classes in docs/privacy-request-discipline.md before a
# commit exists, because both of them have shipped and neither was caught by
# reading the diff:
#
#   1. a request whose ARGUMENT is derived from one user's notes
#      (commitment / nullifier / label / relayed tx hash)
#   2. a request whose TIMING is caused by something the user did
#      (a query gated on a tab, modal or selection)
#
# Runs two ways, on the same staged content:
#   - git:    .git/hooks/pre-commit         (bun run hooks:install)
#   - Claude: PreToolUse on Bash git commit (.claude/settings.json)
#
# Exit 0 = allow, exit 2 = block with an explanation on stderr. Claude Code
# treats a non-zero PreToolUse exit as a refusal and shows stderr to the agent,
# which is the point: the agent gets told WHY and what to do instead.
#
# Deliberate override, one commit at a time:  PRIVACY_PRECOMMIT=off git commit
set -uo pipefail

if [ "${PRIVACY_PRECOMMIT:-on}" = "off" ]; then
  echo "privacy-precommit: skipped by PRIVACY_PRECOMMIT=off" >&2
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$REPO_ROOT" || exit 0

# Only the code an agent writes. Tests and the docs DESCRIBE these patterns, and
# services/onchain-note-index.ts + services/sdk-setup.ts are the sanctioned
# choke points that answer the forbidden reads from bulk data.
staged() {
  git diff --cached --name-only --diff-filter=ACM \
    | grep -E '^(app|components|hooks|services)/.*\.(ts|tsx)$' \
    | grep -v '__tests__' \
    | grep -v '^services/onchain-note-index\.ts$' \
    | grep -v '^services/sdk-setup\.ts$' \
    || true
}

FILES="$(staged)"
[ -n "$FILES" ] || exit 0

FINDINGS=""
note() { FINDINGS="${FINDINGS}$1"$'\n'; }

# Added lines only: an agent must not be blocked by what was already there.
added() { git diff --cached -U0 -- "$1" | grep '^+' | grep -v '^+++' | sed 's/^+//'; }

for file in $FILES; do
  # Strip comments: every rule below is spelled out in prose somewhere, and the
  # prose is not the violation.
  code="$(added "$file" | sed -E 's://.*$::')"
  [ -n "$code" ] || continue

  # --- class 1: the request names a note -------------------------------------
  if grep -qE '\b(getCommitmentTimestamp|getNullifierTimestamp)\s*\(' <<<"$code"; then
    note "  $file: a per-note contract read. Use services/onchain-note-index.ts (bulk)."
  fi
  if grep -qE "functionName:\s*['\"](commitments|spentNullifiers)['\"]" <<<"$code"; then
    note "  $file: readContract on commitments/spentNullifiers. Use the bulk note index."
  fi
  if grep -qE '\b(waitForTransactionReceipt|getTransactionReceipt)\s*\(' <<<"$code" \
     && grep -qE 'relay|relayed' <<<"$code"; then
    note "  $file: receipt poll on a RELAYED tx hash. Use confirmRelayedSpend() (services/relayed-receipt.ts)."
  fi
  if grep -qE '/labels/\$\{|/labels/.*\+\s*label|labels/\$\{label' <<<"$code"; then
    note "  $file: per-label status GET. Use the bulk association-set leaves + /labels/rejected."
  fi

  # --- class 2: the request is caused by the user -----------------------------
  case "$file" in
    app/*|components/*)
      if grep -qE '\b(getPrice|getAllPrices|getTokenPrices)\s*\(' <<<"$code"; then
        note "  $file: a component asking for prices. Read useAllChainsPriceMap() — the feed grid has no enabled and no refetch, so a component cannot cause a request."
      fi
      ;;
  esac
  # `enabled:` computed from UI state is the exact line that leaked "this client
  # is preparing a withdrawal" on 2026-09-18: the flag flipped on tab open and
  # React Query fetched right then.
  if grep -qE 'enabled:.*\b(action|tab|activeTab|isOpen|open|modal|step|selected|expanded|focused)\b' <<<"$code"; then
    note "  $file: a query 'enabled:' gated on UI state. Its first fetch marks the moment the user opened that surface. Move the read onto the public-feed grid, or gate on data readiness only."
  fi
  if grep -qE 'refetchInterval:\s*[^,]*\?' <<<"$code"; then
    note "  $file: a conditional refetchInterval. A poll that pauses during an operation marks the operation by its silence."
  fi
done

[ -n "$FINDINGS" ] || exit 0

cat >&2 <<EOF
privacy-precommit: blocked. Staged changes look like a metadata leak.

$FINDINGS
Both classes and the reasoning: docs/privacy-request-discipline.md
Reviewer checklist: .claude/skills/privacy-review/SKILL.md

A clean payload is not enough. A request also leaks by WHEN it is sent: if a
user action causes it, it announces that action. Public data belongs on the
fixed feed grid (services/public-feed-scheduler.ts), which runs whether or not
anyone is looking.

If this is a false positive, say so in the commit message and re-run with:
  PRIVACY_PRECOMMIT=off git commit ...
EOF
exit 2

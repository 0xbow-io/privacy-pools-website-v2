#!/usr/bin/env bash
#
# Egress allowlist guard for ppv2.
#
# The allowlist in services/egress-policy.ts is FAIL-CLOSED: a field the table
# does not declare is not stripped, it is refused, and the user sees the request
# fail. That makes an omission an outage rather than a warning, and the outage
# lands on whichever flow the missing field belongs to.
#
# It has happened. On 2026-09-22 the SDK's WithdrawalRelayParamsSchema carried
# `processorAddress` and `minUnderlyingOut` for yield routing and the table
# declared neither, so once the policy went to enforce EVERY withdrawal failed
# with "Egress refused (relayer): request body contains undeclared fields".
# ppETH and ppUSDC are the open pools, so there was no unaffected path and
# retrying could not help.
#
# The coverage test did not catch it because its expected field names were
# copied into the test by hand from the same schemas, with the same omissions.
# A list that only agrees with itself proves nothing. The test now derives the
# names from the vendored SDK's zod declarations; this hook is the reminder to
# run it, because the thing most likely to break the table is a re-vendored SDK
# rather than an edit to the table.
#
# Runs as: PreToolUse on Bash git commit (.claude/settings.json), alongside
# scripts/hooks/privacy-precommit.sh.
#
# Exit 0 = allow, exit 2 = block with an explanation on stderr. Claude Code
# treats a non-zero PreToolUse exit as a refusal and shows stderr to the agent.
#
# Deliberate override, one commit at a time:  EGRESS_GUARD=off git commit
set -uo pipefail

if [ "${EGRESS_GUARD:-on}" = "off" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || echo .)}" || exit 0

staged() { git diff --cached --name-only --diff-filter=ACMR 2>/dev/null; }

FILES="$(staged)"
[ -z "$FILES" ] && exit 0

# Two ways the table goes stale. The second is the one that bit us: nobody
# edited the policy at all, the SDK underneath it grew a field.
TOUCHES_POLICY=0
TOUCHES_SDK=0
if printf '%s\n' "$FILES" | grep -qE '^services/egress-policy\.ts$|^services/egress-http-client\.ts$|^services/api-client\.ts$'; then
  TOUCHES_POLICY=1
fi
if printf '%s\n' "$FILES" | grep -qE '^vendor/privacy-pools-v2-sdk.*\.tgz$|^package\.json$|^bun\.lock$'; then
  TOUCHES_SDK=1
fi

[ "$TOUCHES_POLICY" = 0 ] && [ "$TOUCHES_SDK" = 0 ] && exit 0

# The test that actually compares the declared sets against the SDK's schemas.
# It is cheap (a few seconds) and it is the only thing that can tell the
# difference between a table that is right and a table that agrees with itself.
if ! command -v bun >/dev/null 2>&1; then
  echo "egress-allowlist-guard: bun not found, skipping the coverage check" >&2
  exit 0
fi

OUT="$(bun test services/__tests__/egress-policy-coverage.test.ts services/__tests__/egress-policy.test.ts 2>&1)"
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  {
    echo
    echo "BLOCKED: the egress allowlist coverage check failed."
    echo
    if [ "$TOUCHES_SDK" = 1 ]; then
      echo "This commit re-vendors the SDK. The allowlist is fail-closed, so a"
      echo "request field the new SDK added and the table does not declare is a"
      echo "refused request, not a stripped one. That is a user-visible outage on"
      echo "whichever flow owns the field."
    else
      echo "This commit edits the egress policy or a client that goes through it."
    fi
    echo
    echo "Declared field sets live in services/egress-policy.ts:"
    echo "  RELAY_FIELDS / YIELD_RELAY_FIELDS / QUOTE_FIELDS and RELAYER_ROUTES"
    echo "  ASP_ROUTES for the ASP side"
    echo
    echo "Add a field only when it is build configuration, a number, or an"
    echo "address the chain already sees. NEVER declare anything derived from a"
    echo "note: a commitment, a nullifier, a label or a relayed tx hash. If the"
    echo "SDK wants to send one of those, the fix is upstream, not here."
    echo
    echo "Failing output:"
    printf '%s\n' "$OUT" | tail -n 30
    echo
    echo "Override for one commit:  EGRESS_GUARD=off git commit ..."
  } >&2
  exit 2
fi

exit 0

# Public branch integration review

Branch: `fix/public-chain-token-logos`.
Target: `0xbow-io/privacy-pools-website-v2`, `main` at `71db716f9c1eb9fd2232bd50276056321ebb8b8f` (v1.2.0).

## Integration

The changes were applied as separate commits on public main. No private repository ancestry was merged. Public main's version, dependency versions, share-balance and amount-entry fixes, share unwrapping, and Swap layout-loop fixes are preserved. CI workflows are unchanged.

Public PR #2 was already merged through dev into main. This branch replaces its Arbitrum logo implementation with the shared local artwork. Logo conflicts were resolved in favor of this branch; unrelated balance-display code and styling inventory entries were retained from public main.

## Invariants reviewed

- Browser Back and Forward retain screen identity, form drafts, and managed Home panels.
- Cross-chain selections use a single-use, expiring in-memory handoff. Token and amount data do not enter URLs or persistent storage.
- Pool tab selection remains separate from modal deep links.
- Pasted token addresses are matched with their chain. Network selection filters the list; asset selection changes chains.
- Swap remains private to private. Public payout remains in Withdraw.
- Pool identity and legacy links survive disabled deposit routes; transaction eligibility gates remain in place.
- Public share balances and MAX amounts retain their exact share values for calculations. Underlying values remain display-only except at the existing explicit amount-entry boundary.
- The pool dollar balance retains up to two decimal places.
- Destination token selectors do not read public-wallet balances. Payment-source selectors opt in explicitly, and remote token logos remain suppressed under anon-rpc.

## Local lint

The baseline was regenerated from public main at the revision above, not from this branch. New warnings and errors fail; existing findings are matched by file, rule, severity, message, source line, and occurrence count. Checkout paths are normalized. No lint rules are disabled, and `lint:strict` still reports all findings.

## Validation

- Frozen dependency installation and router patch application passed.
- Typecheck passed.
- Bun tests: 5,075 passed, zero failed, across 419 files.
- Sui tests: 162 passed; seven existing skips.
- Production web build passed, with existing dependency export-fallback warnings.
- Local privacy-gate smoke passed, including positive leak detections and a clean control.

- Local lint passed: 911 existing diagnostics, zero new.
- Chromium and WebKit navigation regressions passed, including draft retention, panel and route Back/Forward, focused-chain ownership, light/dark layouts, and rapid navigation.
- `git diff --check` passed.

Funded Sepolia transaction tests and native-device tests were not run locally.

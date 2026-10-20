# Sepolia end-to-end tests

These tests drive the real staging app through Playwright and submit real Sepolia transactions. The headless EIP-6963 wallet signs in Node; its private key is never injected into the page.

## Local setup

Use an ignored `.env` with `DEV_PK` and `DEV_PK2` (or `E2E_ACCOUNT_A_PK` and `E2E_ACCOUNT_B_PK`). A funds the suite; B pays requests. Keep these test keys out of public environment variables.

```dotenv
EXPO_PUBLIC_APP_ENV=staging
EXPO_PUBLIC_TEST_MODE=true
TEST_MODE=true
EXPO_PUBLIC_ASP_URL=https://api-dev.0xbow.io
EXPO_PUBLIC_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
EXPO_PUBLIC_BATCH_WITHDRAWALS=true
```

`EXPO_PUBLIC_ALCHEMY_KEY` is also supported. The scripts default to port 8081, but any port works: the hosted relayers and the ASP accept any origin, so several worktrees can run side by side (set `PROBE_URL` to match). If relayer quotes fail with a CORS error on some port, check whether the relayer has gained an allowlist:

```bash
curl -s -o /dev/null -D - -X OPTIONS https://relayer-staging.example/v1/quote -H "Origin: http://localhost:8082" -H "Access-Control-Request-Method: POST"
```

The response must echo the origin in `access-control-allow-origin`.

```bash
bun scripts/build-snarkjs-worker.mjs
bun scripts/build-witness-worker.mjs
bunx expo start --web --port 8081

# In another terminal:
bun scripts/e2e/ci.ts
# One group, as CI runs it (fund first): E2E_GROUP=fund|core|payment|fixtures
bun scripts/e2e/ci.ts core
# Individual journeys:
bun scripts/e2e/sepolia.ts all 0.001
bun scripts/e2e/payment-request.ts 0.0006
```

Ensure Git LFS circuit artifacts are present and install Chromium with `bunx playwright install chromium`. Screenshots and unregistered-payee backup downloads are saved under ignored `.e2e-shots/`.

## CI and funds

The `e2e-sepolia` workflow runs on pull requests and manual dispatch, not pushes to main. It uses `E2E_ACCOUNT_A_PK`, `E2E_ACCOUNT_B_PK`, and `EXPO_PUBLIC_ALCHEMY_KEY` secrets. Runs are serialized because they share account state.

A and B retain balances and registered viewing keys between runs. The runner tops up B from A. Its default startup minimum is 0.04 Sepolia ETH to cover fixture advances and a B top-up; most of the temporary float returns. Consolidation uses a recoverable account derived from A. Batch withdrawal uses a fresh account derived from A and a random fixture ID printed before funding; retain that ID with A to recover a failed run. Set `E2E_BATCH_FIXTURE_ID` to resume that fixture. Successful batches return the remaining wallet funds to A. Old batch accounts remain recoverable; their dust is not mixed into new fixtures. A fresh account exercises initial registration, shielding, and ragequit; the runner sweeps its remaining wallet balance back to A. If ragequit fails, it retains recovery gas and logs the throwaway key. Treat run logs and backups as private test artifacts.

The ordinary journey caps each deposit/send/withdrawal at 0.001 ETH and waits for its deposits to become approved before proving spends. Payment fixtures finish initial discovery, reuse suitable active or pending notes, and deposit only when necessary. A local run with no group overlaps approval waits in two waves: core with payment, then consolidation with batch, and runs deposit-for and the fresh shield afterward so their approvals cannot rotate the ASP root during earlier proofs. CI runs core, payment and fixtures as parallel jobs held to the same order across runners (scripts/e2e/group-barrier.ts): no group spends until every group's fixtures are approved, and core's deposit-for and fresh shield wait until no group is proving. api-dev also posts a new root for other people's deposits every few minutes. The app re-proves send, consolidation and batch itself when the relayer refuses a proof for a moved root, and splits a batch whose proofs outlast the quote. Standalone commands use the same approval checks without coordination. The default payment comes from paymentRequestEth() (above the $1.15 request minimum at the current ETH price), leaving fee room inside a 0.001 ETH fixture. Consolidation uses a dedicated 0.004 ETH deposit and two self-transfers to create at least three notes of one lineage. It verifies that consolidation spends exactly the pinned inputs and reduces the live note count. Batch withdrawal seeds its account as needed, waits for three approved deposits (E2E_BATCH_SEEDS, six also work; after 15 minutes it goes with at least two approved and logs the label still pending at the ASP), and requires multiple proofs and a confirmed payout. Seeding, pending approval, and relayer failures never count as a batch pass.

Approval normally takes at most ten minutes on Sepolia. After ten minutes, the fixture wait reports delayed approval once per minute and continues polling the same notes. It allows forty-five minutes total by default; set `E2E_APPROVAL_TIMEOUT_MINUTES=60` (minimum 10) to allow a longer service delay. This is an operational grace period, not a new approval expectation. Approval waits return immediately when ready, so healthy runs gain no fixed delay. Exhausting the budget raises `ApprovalTimeoutError` and prevents dependent spends; it never skips the scenario, seeds replacement deposits, or treats pending notes as approved. The workflow's overall timeout still applies.

## Assertions

- Deposits must call the native deposit entrypoint with the intended sender and value and have a successful receipt.
- Withdrawals must pay the recipient; relayed spends must persist their fee and show it in the correct transaction detail.
- Sends must reach the explicit success state; an unknown outcome fails.
- Payment requests and deposit-for must appear as owned notes in the recipient's SDK export, matched to the actual transaction.
- Unregistered requests must preserve the backup flow, persistent payer success, history, and recipient discovery through reload or the visible refresh control. These checks do not assert automatic background discovery. Blind deposits to unregistered addresses must confirm and produce a claim link whose recipient, note, asset and amount match the deposit.

The driver scopes fields to the active pager page or dialog, explicitly selects ETH on Sepolia, and clicks actionable controls. It unlocks signed activity after a full page reload before asserting reconstructed history.

## Privacy checks

The `all` and `withdraw` journeys observe withdrawal preparation: two 65-second idle controls followed by opening the form and typing an amount. The windows place any five-minute price-feed tick in an idle control before the action, so scheduled price refreshes have an observed baseline without an endpoint exemption. The policy checks private note data and traffic before transaction consent. Withdrawal and send also capture request contents through proving, submission, confirmation, and a post-transaction observation window. Only newly created commitments in the submitted proof's output slots are treated as intentional disclosure; other fields, headers and RPC queries retain content checks. This does not assert transaction-independent traffic timing. Standalone shield/ragequit phases assert transaction behavior without claiming this preparation verdict.

Capture stops and is assessed before releasing memory. Missing windows, incomplete capture, and privacy violations fail. Poll budgets preserve URL, method, parameters, and cadence; JSON-RPC correlation IDs are normalized only for timing comparisons. A CORS preflight must pair with a budget-approved request to the same URL and method in the action window; cache expiry does not grant an OPTIONS exemption. Content checks still inspect the original requests and preflight headers. Decimal values are not mistaken for fragments of ABI words.

Run the existing browser self-checks without an app, wallet, or funds:

```bash
bun scripts/e2e/network-capture-smoke.mjs
bun scripts/e2e/privacy-gate-smoke.mjs
```

These checks exercise actual network capture, secret harvesting, deliberate leaks, timing violations, and clean traffic. The policy retains its explicit activity-feed address waiver; it does not broadly exempt RPC or ASP endpoints.

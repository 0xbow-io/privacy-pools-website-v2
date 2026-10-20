# Privacy request discipline: no request may name a note

Privacy Pools protects on-chain linkability. It does not protect the client's own
network metadata. This document is the rule that keeps the website from leaking
what the protocol hides, and it is enforced by a test and a hook. Read it before
adding any RPC or HTTP call on a user-reachable path.

## The leak class

A request leaks when three things are true at once:

1. The client sends a **targeted** request whose argument is a secret-derived
   value: a note commitment, a nullifier, a label hash, a note-address hash, or
   the counterparty of a private payment.
2. That same value later appears **publicly on-chain** (or is already known to
   the party being asked).
3. One party sees both halves from the same IP / API key / TLS session: the RPC
   provider for `eth_call` / `eth_getTransactionReceipt`, the ASP for HTTP, any
   proxy or CDN in between.

No cryptography is broken. The client volunteers the link.

This was not theoretical. On 2026-08-26 an instrumented real Sepolia send
(`E2E_RPC_CAPTURE`) showed the browser issue **108 `PoolVault.spentNullifiers(n)`
eth_calls, 554 `PoolVault.commitments(c)` eth_calls and 297 `GET
/labels/<label>/status` requests**. One of the queried nullifiers was published
by the relayed transaction **15 seconds later**. The relayer indirection was
nullified at the network layer on every transfer.

## The second leak class: timing

A request with a perfectly clean payload still leaks if **the moment it is sent**
is caused by something the user did. The observer does not need to read the
request; it only needs to notice that it happened, and when.

On 2026-09-18 the e2e privacy gate failed with **0 leaks and 2 timing
violations**:

```
TIMING: "open the Withdraw tab and type an amount" caused a request no
measured background poll explains
  GET https://api-dev.0xbow.io/global/public/token-prices
```

The cause was one line. A price query was written as
`useQuery({ queryKey: ['tokenPrice', symbol], enabled: action !== 'shield' })`.
Shield is the landing tab, so the `enabled` flag flipped the instant the user
opened Withdraw, and React Query put a request on the wire right then. The URL
names a public endpoint, carries no address and no amount, and would pass every
payload rule on this page. It still told the ASP: *this client just started
preparing a withdrawal.*

The same shape had shipped three more times without being noticed — the withdraw
chips re-fetched on every pool pick, the deposit modal fetched when it opened and
on every token change, and the yield card fetched whenever the portfolio opened.

Three ways this class appears, all of them ordinary-looking React:

| Pattern | What it announces |
|---|---|
| `enabled:` gated on a tab, modal, route or form state | the user just opened that surface |
| a `queryKey` containing something the user picks (token, pool, amount) | the user just chose that thing |
| `refetchInterval: busy ? false : N`, or any poll that pauses | a poll that goes quiet for exactly the length of a transaction marks the transaction |

The rule is the same one from the other direction: **a request leaks by WHEN it
happens and by NOT happening.** Absence is a signal too.

The fix is never "sanitise the payload"; it is to move the read off the user's
timeline entirely. `services/public-feed-scheduler.ts` fetches public data on a
fixed grid that runs whether or not anyone is looking, and the hooks over it
(`usePublicFeed`, `useAllChainsPriceMap`) have **no `refetch` and no `enabled`**,
so a component reading them cannot cause a request at all. That is the property
to preserve: not "this component fetches carefully" but "this component cannot
fetch".

A poll that PAUSED for a transaction is fixed the same way, on a fixed cadence,
plus whatever made the pause feel necessary handled locally. For the wallet
balances that was the display (`hooks/use-latched-while.ts`: keep polling, hold
the figure). For the activity feeds it was meaning: our own in-flight deposit
used to be an optimistic row written into the feed's cache, which a tick wiped
and a second feed source duplicated. It is a local ledger entry now
(`services/pending-own-rows-store.ts`), and `services/feed-reconciliation.ts`
merges the feeds against it by `(chainId, txHash, row type)`, so a feed
returning our own operation is recognised as ours and shown once. The matching
is a `Set.has` over data the client already holds; no request is keyed on it.

### Our own operation is a user action too

The same shape hid in the flows themselves. Every deposit, transfer, withdrawal
and claim refreshed things when it confirmed (react-query invalidations of the
events feed, the association set and the asset statistics at confirm, +5s and
+15s; discovery passes at +5s and +15s, or right after a relayed spend), and a
transfer ran a discovery pass the moment the user pressed Send, before the
proof. Opening Withdraw on a pending deposit ran one too. Every payload was
public. Every one of them told the ASP "the operation that just landed on chain
was this client's", and the passes after a relayed spend tied the IP to the
very transaction the relayer exists to detach from it.

The fix is the same as for the feeds: the flow applies what it already knows,
locally, and leaves the rest to the clock.

- `invalidateTransactionCaches` (`services/cache.ts`) touches only queries whose
  queryFn reads held data; nothing repeats it on a timer.
- A deposit writes its prepared note to the note manager, stamped from the
  block our own wallet's transaction mined in. A spend marks its inputs SPENT
  (so the next send cannot reselect one) and keeps the SDK's change note. No
  flow runs discovery at confirmation or before a proof.
- Discovery runs on the grid: one quiet pass each time the grid lands the
  session chain's event snapshot (`components/sdk-provider.tsx`). That is what
  confirms our own operations, for every client at the same instants.
- Everything a proof or a discovery pass reads from the ASP is held by the
  grid and only read: the event snapshot (and its Note section, which is where
  discovery's Note events come from), the state and keystore leaves, the
  association set, the label decisions, the ASP key a deposit's ciphertext is
  sealed to. A pass, whatever starts it (sign-in, an import, the sync button),
  asks the ASP nothing; the blocks above the held copies come from an RPC tail.

## The rule

> Every client must produce the **same request stream**, at the **same times**. A
> request may carry chain-wide parameters (block ranges snapped to a shared grid,
> an entrypoint, a pool address) and must be caused by the clock, not by the
> user. It may never carry a value derived from one user's notes, and its timing
> may never correlate with what the user is doing.

Concretely, on any path a user can reach:

| Never | Instead |
|---|---|
| `poolVaultInteractor.getCommitmentTimestamp(c)` / `getNullifierTimestamp(n)` (`eth_call commitments(c)` / `spentNullifiers(n)`) | `OnChainNoteIndex` (`services/onchain-note-index.ts`): `hasCommitment`, `commitmentTimestamp`, `isNullifierSpent`, `findTransacted` |
| `readContract({ functionName: 'commitments' \| 'spentNullifiers' })` or the same through a raw ABI | same |
| `publicClient.waitForTransactionReceipt({ hash })` / `getBlock` for a **relayed** transaction | `confirmRelayedSpend()` (match the Transacted event by our nullifiers + outputs in bulk data) |
| `GET /labels/{label}/status` per label | bulk `association-set/leaves` (approved) + `GET /labels/rejected` (declined); neither means pending. Pending in the SDK tarball until it is rebuilt; see `SDK_PATCHES.md` |
| raw sync cursor as `fromBlock` / `?since=` | `alignLogScanStart()` (`services/log-scan-alignment.ts`): snapped DOWN onto a 10 000-block grid |
| ENS lookup of a counterparty over the pool RPC | off by default (`EXPO_PUBLIC_ENS_RESOLUTION`), separate `EXPO_PUBLIC_ENS_RPC_URL` when on |
| narrowing a bulk fetch to "only the blocks with my notes" | fetch every distinct block in the tail set (see `fetchBlockTimestamps`) |

Receipt polling of a transaction **the user's own wallet broadcast** (deposits,
registrations, ragequits, the disclosed/direct transfer path) is fine and is the
authoritative confirmation there, revert included: the provider already saw it
arrive from this client. The rule bites on anything the relayer submitted for
us; those flows confirm with `confirmRelayedSpend()`.

Relayed confirmation semantics, decided the hard way on 2026-08-26:

- a spend is matched on **our nullifiers** (a nullifier is consumed exactly
  once on-chain, so the event holding all of ours is the spend of our inputs);
- a **conflict** is the observed event's txHash being known and different from
  the hash the relayer returned (another device / a replacement spent our
  inputs first): nothing is recorded for the submitted operation;
- the expected output commitments are compared and logged (`outputsMatch`) but
  never gate confirmation: on a verified own-hash spend they read false, so the
  commitments the flows hold are not the emitted ones (open question);
- a receipt status the vendored SDK saw as `false` is a revert and ends the flow
  first; a `true` is accepted as fallback confirmation when the bulk index has
  not caught up (that internal poll cannot be removed on the website side);
- "not observed and no SDK receipt" is submitted-unconfirmed, never success.

## What the bulk index guarantees, and what it does not

- Presence and spent state come from every Deposited / Transacted / Ragequit
  event in the ASP snapshot plus the chain tail, independent of whether a block
  timestamp resolved. A note whose `getBlock` failed is still present; a
  nullifier in such a block is still spent.
- Timestamps are verified against the state-tree leaves before being served;
  an unverifiable timestamp reads as unknown, never as absent.
- The ASP snapshot is parsed as a whole and discarded entirely on any malformed
  row (no partial merge). Its **advertised** boundary (`snapshotBlockNumber`) is
  not trusted: the ASP reports the chain head while its rows lag by minutes
  (a relayed spend mined at 04:18 appeared in the snapshot at 04:24). The chain
  tail starts at `min(advertised, newest row blockNumber) - 300` blocks; rows
  without `blockNumber` prove no coverage and force a full chain scan.
- Freshness: decisions can lag the chain by the ASP snapshot cadence plus one
  log scan. A note spent seconds ago may still look ACTIVE and revert at the
  relayer instead of being filtered in preflight. Correct, just later.

## Choke points for code this repo does not control

The vendored SDK still issues per-note reads internally (note discovery,
`addNotes`, `recoverRejectedNotes`) and per-label status GETs. Both pass through
website wrappers, and the wrappers answer them from bulk data instead of
forwarding:

- `ChunkedRPCInteractor.readContract` (`services/sdk-setup.ts`): a
  `commitments(c)` / `spentNullifiers(n)` read against the pool is answered from
  the `OnChainNoteIndex` (verified timestamp or 0; spent or 0). It is never
  forwarded, not even for a present-but-unverified commitment.
- the ASP data provider's `getLabelStatus` (`services/sdk-setup.ts`): approved
  labels come from the association-set leaves, declined ones from
  `GET /labels/rejected`; only the small remainder (pending / poi_required)
  still goes per label, because the Claim UI needs the poi_required
  distinction that no bulk list expresses yet.

So the request stream is bulk-only even before the SDK tarball is rebuilt,
except for that pending/poi_required remainder and the SDK's internal receipt
wait on a relayed hash (`relayTransfer` / `relayWithdraw`), which only an SDK
change can remove.

## Enforcement

- `services/__tests__/no-targeted-reads.test.ts` fails CI on any occurrence of
  the forbidden identifiers / `functionName` strings in `services`, `components`,
  `hooks`, `app`. Allow-list entries are known open instances, each with a
  reason, not exceptions to the rule.
- `services/__tests__/price-map-merge.test.ts` fails CI if any file under
  `components/` or `app/` calls `getPrice`, `getAllPrices` or `getTokenPrices`.
  Prices come off the feed grid or not at all. This ratchet existed but listed
  only the two bulk functions, and `getPrice` hits the same endpoint — which is
  exactly how four component-triggered price fetches shipped.
- `services/__tests__/no-activity-correlated-polling.test.ts` walks `useQuery`
  options and effect bodies for polls that pause or resume with activity.
- `services/__tests__/snapshot-request-timing.test.ts` pins the pool data a
  proof or a discovery pass reads to the grid, and discovery to the places
  that may run it (the session owner, the grid, the user's own commands);
  `services/__tests__/transaction-cache-keys.test.ts` fails when
  `invalidateTransactionCaches` touches a network-backed query.
- `scripts/hooks/privacy-precommit.sh` runs over **staged** changes, as a git
  `pre-commit` hook and as a Claude Code `PreToolUse` hook on `git commit`. It
  is the fast, local copy of the rules above, so an agent hears about a
  violation before the commit exists rather than 70 minutes later in e2e.
  Install: `bun run hooks:install`. Override once, deliberately, with
  `PRIVACY_PRECOMMIT=off git commit …`.
- `.claude/skills/privacy-review/SKILL.md` and `.agents/skills/privacy-review/`
  are the reviewer's checklist for both leak classes; `AGENTS.md` points every
  agent at them.
- The e2e privacy gate (`scripts/e2e/`) records every request a real run makes
  and fails on a **timing** violation as well as a payload leak: any request
  caused by a user action that no measured background poll explains.
- The Claude Code PreToolUse hook `privacy-no-targeted-reads.sh` (in the
  developer's `~/.claude*/hooks/`) blocks an Edit/Write that would introduce one
  of these patterns into this repo before it reaches disk.
- `scripts/e2e/lib.ts` `E2E_RPC_CAPTURE=<file>` records every JSON-RPC and ASP
  request a run makes. Target for any send: zero `0x811608fd`
  (`spentNullifiers`) / `0x49ce8997` (`commitments`) eth_calls and zero
  `/labels/<n>/status`.

## Known open instances (2026-08-26)

- `services/sui-witness/*`: Sui witness reconstruction reads the pool's
  `getCommitmentTimestamp` Move view per note. Same class on the Sui RPC; needs
  a Sui event index. Sui is testnet-only.
- Inside the vendored SDK tarball (closes when rebuilt from the upstream
  `privacy/rpc-metadata-leaks` branch rebased onto the current lineage):
  post-relay `resolveCommitmentTimestamp` in `TransactOrchestrator`, the
  per-label status fan-out and `recoverRejectedNotes` in note discovery, the
  internal receipt wait in `relayTransfer` / `relayWithdraw`, and
  `addNotes` on the reshield path.

References: `v2-monorepo/docs/PRIVACY_RPC_METADATA_AUDIT.md`,
`v2-monorepo/docs/PRIVACY_RPC_METADATA_FIX_PLAN.md`, asp-v2 PR #115.

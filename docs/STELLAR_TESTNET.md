# Stellar testnet

The website runs the Privacy Pools v2 Stellar (Soroban) testnet deployment through
the same UI as the EVM pools: the home action hub, the pool page, and the deposit,
withdraw, transfer and exit modals. Stellar is one more network in the selector, shown on staging with `?stellar=true` (remembered in the browser, `?stellar=false` forgets it) or with the debug gate (`?debug=1`). It has no swap or cross-chain routes; payment requests work (XLM only).

## What it talks to

| Piece | Where |
|---|---|
| Contracts | `config/stellar-deployment.ts` (redeployed from scratch by Artem on 2026-10-29) |
| SDK | `@privacy-pools-v2/stellar-sdk`, vendored as `vendor/privacy-pools-v2-stellar-sdk-*.tgz` |
| Wallet | Freighter (`components/stellar-wallet-provider.tsx`) |
| ASP + event history | asp-v2, the environment's ASP like every other chain (`EXPO_PUBLIC_ASP_URL`, the dev asp-v2 in staging): `/association-set/{root,leaves}`, `/labels/{rejected,poi-required}`, `/public-key` and `GET /202/public/events`, scoped to chain 202 and the pool |
| Relayer | the v2 relayer (v2-monorepo `packages/relayer/relayer`), Stellar testnet only, at `EXPO_PUBLIC_STELLAR_RELAYER_URL` (`/v1/details\|quote\|relay/stellar/1/…`), via `services/stellar/stellar-relayer.ts` |
| Circuits | the EVM set in `public/artifacts`, reused unchanged by the Stellar verifier |

The 2026-10-29 deployment (Artem, from scratch, new deployer) replaced the 2026-09-30
one: the old deployer key was lost and its contracts probably still verified with the
dev circuit keys (deposit failed with InvalidProof, error #4). The addresses come from
his Slack DM and have not been checked on-chain from this repo; the ASP and the Stellar
relayer must point at the same contracts. Native XLM keeps a 1 XLM deposit floor in the app.

## Run it

1. Build and vendor the SDK (from a v2-monorepo checkout at the deployed commit),
   then install:

   ```bash
   bash scripts/stellar/build-stellar-sdk.sh ~/Claude/v2-monorepo-v2.0
   bun install
   ```

2. The app uses the environment's ASP (`EXPO_PUBLIC_ASP_URL`): asp-v2, which on the
   current deployment is the registry's postman and approves whitelisted depositors
   only. `EXPO_PUBLIC_STELLAR_RELAYER_URL` names the relayer (see `.env.production`);
   without it withdrawals refuse.

3. Start the app and open it with `?stellar=true`, pick **Stellar Testnet** in the chain
   selector, and connect Freighter (set to Testnet, account funded with friendbot).

   ```bash
   bun run web
   ```

   Staging only: the prod environment ignores `?stellar=true`. A prod build shows
   Stellar only when built with `EXPO_PUBLIC_STELLAR_ENABLED=true`.

## Hosted preview (Vercel)

Every visitor's browser calls the ASP (`EXPO_PUBLIC_ASP_URL`) and the relayer
(`EXPO_PUBLIC_STELLAR_RELAYER_URL`) directly; both are public https services whose CORS
allows the website origins. Use the branch preview URL with `?env=staging&stellar=true`.

## How a deposit becomes spendable

1. The first action asks Freighter to sign a never-submitted key-derivation
   transaction. Keys are derived from that signature (SDK `StellarCryptoService`,
   app identifier `privacy-pools/stellar/account-seed:v1`) and kept in memory only.
2. The deposit proof is built in the browser and `pool.deposit` is submitted.
3. The deposit's ASP ciphertext is posted with `asp_registry.register_label`. The
   SDK builds this ciphertext but the Stellar entrypoint adapter discards it
   (`_aspCiphertext`), so the app submits it itself. That is a second Freighter
   approval. This is a gap in the SDK, which should do this step itself.
4. asp-v2 decrypts it and recomputes label and commitment, checks that commitment
   against the `deposited` event, approves the label if the depositor is whitelisted
   for this pool, then publishes the new root.
5. The next sync promotes the note to ACTIVE and it can be withdrawn or sent.

The first deposit registers the keystore first (two more Freighter approvals, once per
account), like EVM and Sui. The deposit already names the account, so this reveals nothing
new; registering at the first withdrawal instead would put the registration seconds before
the relayed withdrawal and link the two. An account that holds notes but is not registered
yet registers at its first withdraw, transfer or exit.

## Payment requests

The Request tab creates a blind request link, `/pay/xlm.<base64url JSON>`
(`services/stellar/stellar-request.ts`): the SDK's `generatePaymentRequest` on the
Stellar session (five note slots, a per-request payment key, a tag, the XLM asset
contract as `tokenId`, a seven-day `expiresAt`), in the same v3 envelope EVM uses
(`ppv2-sdk-payment-request`, chain id 202, `services/payment-request-codec.ts`). The link
names no account and has no signature. Nothing is sent on chain and no viewing key is
published to create one.

The payer's `/pay` page (`components/stellar-pay-request.tsx`) pays it with
`prepareFulfillPaymentRequest` and the normal Stellar transfer submit. The recipient's
sync finds the note through the request record the SDK keeps in the account, marks the
request FULFILLED, and the Payment Requests list shows it paid.

That record (with the slots' note secrets) is the only way the payment is found. As on EVM
it is kept in localStorage (`services/stellar/stellar-request-storage.ts`, per account and
app environment, plaintext like the EVM request store), and making a request downloads a
request backup file (`ppv2-stellar-request-backup`, no password, like the EVM one). A new
tab restores the records into the session, so a payment is still found after a reload.
The account modal and Import Payment Requests restore the file. Signing out or switching
Freighter accounts removes the records the user is proven to hold a backup of: the save-file
picker wrote the file (the Download button, where the browser has the picker), or an imported
backup holds the same recovery data. The automatic download and a plain download prove
nothing, so those requests are kept (same model as the EVM purge, PR #209).

Links made before this (`ppv2-stellar-payment-request`, naming the recipient's G... address)
still open and pay on the payer side through the prefilled Send flow.

## Per-note timestamp reads

Discovery asks the pool when each newly found commitment was inserted. The Stellar adapter
answers that from a whole-history event scan per commitment (no getter on the contract), so
nothing in the request names the note, but the count of requests would follow the number of
notes found. A sync runs inside `withEventPage` (`services/stellar/stellar-runtime.ts`): every
whole-history pool read in the pass, and the activity index's, is answered from one page.

## Relayed withdrawals

The relayer is the v2 relayer (v2-monorepo `v2.0`, `packages/relayer/relayer`), run by us
for testnet with a Stellar-only config. A withdrawal is proved against the relay contract
as processor and submitted by the relayer, so the user's account never appears on it. The
fee is 50 bps on top of the amount (XLM `fee_bps: 50`), capped at XLM's on-chain
`max_relay_fee` (0.1 XLM on the 2026-09-30 deployment).

The app talks to it through `services/stellar/stellar-relayer.ts`, a copy of v2.0's SDK
`StellarRelayerInteractor`: the vendored SDK (`c81ba9d5`) still speaks the old reference
relayer's `/api/v1/relayer/*` protocol. Delete the copy once the SDK is re-vendored with
v2.0's interactor. The SDK's withdraw builder checks that the quoted routing pays the user's
recipient and that `amountSent` is amount + fee. The relayer is handed to the session only
while a withdrawal runs: the SDK asks every relayer it has for a quote even on a
self-submitted transfer, and the relayer refuses transfer quotes.

## Why events come from the ASP

Soroban RPC only serves a recent window of events, and the SDK clamps every fresh
scan to the last 1000 ledgers (~80 minutes). A session opened later would rebuild
incomplete state and keystore trees and every proof would fail. So
`services/stellar/stellar-runtime.ts` gives the session an RPC interactor whose
`getEvents` (history and cursor reads) and `getLatestLedger` read asp-v2's
`GET /202/public/events`, which archives the deployment's whole history and returns
the same objects the SDK would have built. Nothing event-related goes to RPC: the
head is asp-v2's indexed ledger, so a sync never passes events it has not served (a
just-landed one appears on the next sync, ~15 s later), and if asp-v2 is down the
sync fails rather than silently scanning a clamped RPC window.

## Not done yet

- Private transfers are still self-submitted (the pool sees the sender's account as
  processor): the Stellar SDK refuses to relay a transfer. Withdrawals are relayed. The
  Send review says so. Exits (ragequit) are public by design, as on EVM.
- Sending names the recipient to the Soroban RPC once, inside the SDK's own
  `transfer()` (it reads the recipient's viewing key to encrypt to it). The app makes no
  separate lookup, but that one read is upstream and stays until the SDK can take a
  prefetched key.
- The account export (every note secret) is kept in sessionStorage, so a new tab
  rediscovers notes from chain. Payment-request records are the exception (above). Background reads run on a fixed 30s wall-clock grid and
  never right after a flow; an explicit Sync or Sign in also reads when the user asks.
- asp-v2 approves whitelisted depositors only on this pool (everyone else is declined).
- Swaps, yield and deposit-to-another-address are hidden on Stellar, as on Sui.
- Like Sui, the Stellar stack sits outside the EVM egress chokepoints
  (`services/egress-policy.ts`). Reads are bulk (by contract id and start ledger)
  and the balance poll runs on a fixed cadence, but nothing enforces that.

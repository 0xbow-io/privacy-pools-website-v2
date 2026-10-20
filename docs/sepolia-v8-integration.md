# Sepolia v8 integration — circuit artifacts, ASP, relayer

Answer to the integration questions (circuit artifacts / ASP `/public-key` / relayer),
cross-checked against three repos:

- **WEB** — `ppv2` (this app)
- **SDK** — `v2-monorepo/packages/sdk`
- **ASP** — `asp-v2`

Every claim below was verified twice: once by hand and once by an independent
code-reading pass (Codex). File:line refs are included so the client can confirm.

---

## TL;DR

1. **Circuit artifacts — embed / self-host them.** The SDK has an IPFS path, but the
   default CID manifest is **empty and throws at construction today** — there are no
   pinned CIDs to fetch yet. Bundle the `deposit` / `ragequit` / `transact_NxM`
   artifacts as static files (what this app does).
2. **ASP — yes, `/public-key` exists; integrate it (don't ignore).** Live at
   `https://api-dev.0xbow.io`. You need the ASP public key **even for a deposit-only
   flow** (the deposit encrypts a ciphertext to it). Root, leaves, and entrypoints
   come from the same ASP.
3. **Relayer — yes, there's a URL, but only for spends.** Sepolia relayer is
   `https://relayer-staging.example`. Deposits don't use it
   (submitted directly); withdrawals/transfers do. Deposit-only PoCs can skip it.
   (The `-testing-` instance is NOT interchangeable: it posts Sepolia from the V8
   relay, so relayed spends bound to the V9 relay revert with
   `PoolVault_ProofContextMismatch`. Verified 2026-08-23.)

---

## Q1 — Circuit artifacts: embed them; IPFS CIDs are not usable yet

The SDK ships **two** `ICircuitArtifacts` implementations:

- `LocalCircuitArtifacts` — `SDK/src/services/circuitArtifacts/LocalCircuitArtifacts.ts:6`
- `IpfsCircuitArtifacts` — `SDK/src/services/circuitArtifacts/IpfsCircuitArtifacts.ts:28`

`PoolSessionBuilder` accepts `circuitArtifactsDir` **or** `circuitGatewayUrls` —
the schema rejects supplying *both* (`SDK/src/schemas/PoolSessionBuilder.ts:80-85`).
Note it's "not both," not strict XOR: you may also supply **neither**, in which case
the builder falls back to the default IPFS path.

**Why the IPFS path is not usable today** (the key finding for "are they available via
IPFS CIDs, presumably yes" → *not yet*):

- `DEFAULT_IPFS_GATEWAY_URLS = ["https://ipfs.io/ipfs"]` — `SDK/src/constant/CircuitArtifacts.ts:21`
- `EMPTY = { wasm: "", provingKey: "", verificationKey: "" }` — `CircuitArtifacts.ts:23`
- Every `DEFAULT_CIRCUIT_MANIFEST` entry is `{ ...EMPTY }` — `CircuitArtifacts.ts:34-62`
- The SDK's own type comment: the all-omitted path uses the defaults and
  **"Construction throws today"** — `SDK/src/types/PoolSessionBuilder.ts:147-150, 173-177`
- The builder throws when no manifest CID is pinned — `SDK/src/services/poolSessions/PoolSessionBuilder.ts:680-688`

So there are **no published CIDs** to point at. If you want IPFS you'd pin and pass
your own manifest — at which point static self-hosting is simpler.

**How this app does it (recommended):** serves artifacts as static files and fetches
over HTTP.

- Base URL = `${window.location.origin}/artifacts` (server fallback `/artifacts`) —
  `WEB/components/sdk-provider.tsx:27-28`, passed to `createCircuitArtifacts` at `:590`
- `RemoteCircuitArtifacts` URL scheme — `WEB/services/sdk-setup.ts:342-368`:
  - `<base>/<circuit>/<circuit>_js/<circuit>.wasm`
  - `<base>/<circuit>/groth16_pkey.zkey`
  - `<base>/<circuit>/groth16_vkey.json`
- Artifacts present in `WEB/public/artifacts/`: `deposit`, `ragequit`, and the full
  `transact_1x1 … transact_5x5` family, each with the `*_js/*.wasm` +
  `groth16_pkey.zkey` + `groth16_vkey.json` triplet.

> The proving keys (`groth16_pkey.zkey`) are large — put them behind a CDN / cache.

---

## Q2 — ASP: `/public-key` exists; integrate it

Live ASP (NestJS api-gateway) at **`https://api-dev.0xbow.io`** (dev).

| Endpoint (full path) | Source |
|---|---|
| `GET /public-key` | `ASP/apps/api-gateway/.../asp-data.controller.ts:102-115` (controller has no prefix) |
| `GET /association-set/root` | `asp-data.controller.ts:28-49` |
| `GET /association-set/leaves` | `asp-data.controller.ts:52-75` |
| `GET /labels/:labelHash/status` | `asp-data.controller.ts:78-99` (labelHash is **decimal**) |
| `GET /global/public/events` | `global-public.controller.ts:30-154` |
| `GET /global/public/statistics` | `global-public.controller.ts:156-170` |
| `GET /global/public/token-prices` | `global-public.controller.ts:173-192` |
| `GET /global/public/entrypoints` | `global-public.controller.ts:195-209` |
| `GET /partner/assets` | `partner.controller.ts:69-86` |
| `GET /partner/deposit/status` | `partner.controller.ts:95-139` |

> Path prefixes matter: `/public-key`, `/association-set/*`, and `/labels/*` are at
> **root**; events/statistics/token-prices/entrypoints live under **`/global/public/`**;
> assets/deposit-status under **`/partner/`**. This app calls exactly those paths
> (`WEB/services/api-client.ts:113-180`), so they're confirmed against a live consumer.

**You need the ASP even for deposit-only.** Deposit preparation always builds an ASP
ciphertext:

- `PoolSessionDeposit.prepareDeposit` builds it — `SDK/src/services/poolSessions/PoolSessionDeposit.ts:275-281`
- `generateASPCipherText()` calls `aspClient.getASPPublicKey()` — `PoolSessionDeposit.ts:456-457`
- ciphertext = `viewingPublicKey ‖ encrypted(payload)` — `SDK/src/utils/ASPUtils.ts:28-33`

For withdrawals/transfers you additionally need `association-set/root` + `/leaves`.

**How this app wires it:** the SDK's `HttpASPDataProvider` fetches `${aspUrl}/public-key`
(`SDK/src/services/aspDataProviders/HttpASPDataProvider.ts:95-99`), driven from
`WEB/services/sdk-setup.ts:421-423`, with a static `ASP_PUBLIC_KEY` env fallback
(`WEB/config/env.ts:30-41`, used at `sdk-setup.ts:381-382, 433-445`). The public key
can be configured statically, but fetching `/public-key` is the source of truth.

---

## Q3 — Relayer: URL exists; only needed for spends

- Sepolia relayer base URL — `WEB/config/chains.ts:40-46`:
  `https://relayer-staging.example` (a Cloud Run staging service)

**Deposits don't use the relayer**; withdrawals/transfers do (the relayer submits the
tx so `msg.sender` isn't the user — the privacy point):

- `PoolSessionFactory` constructs `PoolSessionDeposit` **without** a `relayerInteractor`;
  transfer/withdraw **do** get one — `SDK/src/services/poolSessions/PoolSessionFactory.ts:60-75, 129-150`
- Deposit submits directly via `entrypointInteractor.submitTransaction` — `PoolSessionDeposit.ts:172-178`
- Transfer → `relayerInteractor.relayTransfer` — `PoolSessionTransfer.ts:54-64, 144-156`
- Withdraw → `relayerInteractor` quote + `relayWithdrawal` — `PoolSessionWithdraw.ts:28-36, 54-58, 104-115`

So: deposit-only scope can ignore the relayer. Once you do withdrawals/transfers,
either use this relayer or submit directly (losing `msg.sender` unlinkability).

---

## Sepolia deployment addresses (the actual "v8")

Source of truth is the SDK's `DEPLOYMENTS` constant — `SDK/src/constant/deployments.ts:16-22`,
chainId `11155111`:

| Contract | Address |
|---|---|
| Pool | `0xc131a029e8096fd427c2c2fd489b77c80b21574a` |
| Entrypoint | `0x8445493038708311e55a526587d6ec4338377df0` |
| Keystore | `0xbb52626b05aad8950c6e90397aef3c3cab7d9ed1` |
| ASP Registry | `0xfb68cc6b6572c130bc65e98b8df549cf05bb7665` |

> The constant isn't literally tagged "v8" — the SDK author bumps these on each
> redeploy, so **read this constant from the latest SDK rather than hardcoding**
> (the deployment markdown files lag). The Entrypoint is also discoverable at runtime
> via `GET /global/public/entrypoints`, so it doesn't have to be hardcoded.

---

## Verification note

All claims above were independently re-read by Codex against the three repos and came
back **CONFIRMED**, with three precision refinements already folded in:

1. The builder enforces "not both" for `circuitArtifactsDir` / `circuitGatewayUrls`,
   not strict XOR (neither is allowed → defaults to IPFS → throws today).
2. The `/global/public/*` and `/partner/*` ASP routes carry controller prefixes;
   `/public-key`, `/association-set/*`, `/labels/*` are at root.
3. The app reads `/public-key` through the SDK's `HttpASPDataProvider`
   (`baseProvider.getASPPublicKey()`), not the standalone `apiClient.getASPPublicKey()`
   helper — both hit `/public-key`.

# Multisig & "intents" in Privacy Pools v2 — research notes

Scratch/reference doc (not committed). Captures what the protocol supports today,
the multisig design options, the **Bermuda decision**, and what it all means for
the Payroll app. Two unrelated things both use the word "intent" — they're kept
separate below.

Sources:
- `v2-monorepo/docs/tech-design/future-ideas/multisig-support.md`
- `v2-monorepo/docs/tech-design/overview.md`, `.../key-architectural-concepts.md`, `.../contracts/contracts-tech-design.md`
- HackMD "Intents: State of the art" — https://hackmd.io/YV_t4QPCR4eZ3dnsUTIfYg

---

## 0. Current state (v2.0)

- v2.0 implements **`authType = 0` (Direct Key Authorization)**: the prover
  demonstrates knowledge of `privateNullifyingKey` via a hash preimage. Single
  signer only.
- **No multisig is implemented anywhere.** Checked all ~53 monorepo branches: no
  commits mention multisig/intent/authType/FROST; the multisig-specific
  primitives (`authType=2`, `intentsTree`, `intentCommitment`, `authorizerAddress`)
  exist **only in docs**, not in code. (`authorizerDigest` in branch code is the
  existing single-key keystore auth, not multisig.)
- Governance multisigs exist but are **not user-facing**: Upgrade Committee,
  Emergency Council, `OPS_ADMIN_ROLE` (fast multisig) — contract admin only.
- The architecture is deliberately future-proofed: the extensible `authType`
  field is meant to add multisig/hardware wallets later "without forcing another
  [anonymity-set] reset."

---

## 1. Multisig owner — the two design options (from `multisig-support.md`)

A ZK protocol verifies ownership by knowledge of a private key, but a contract
(Safe/DAO) can't hold one. Two ways to bridge that gap:

### Option A — Intent-based authorization (`authType = 2`)  *(NOT the chosen path)*

The contract **posts a public on-chain "intent"** (a commitment to a future
private tx); the spend circuit proves that intent exists and was created by the
account's registered authorizer.

- **Dedicated circuit** (separate from base `transact`) so single-signers don't
  pay its proving cost. `authorizerAddress` = the stealth contract allowed to
  post intents (0 for authType 0/1).
- **Intent data structure:**
  - `transactionDetailsHash` — commits to the exact input notes/outputs (so the
    executor can't alter the tx).
  - `intentSecret` — fresh random private value (never shared with the relayer).
  - `publicIntentHash = Poseidon(transactionDetailsHash, intentSecret)`.
  - `intentCommitment = Poseidon(authorizerAddress, publicIntentHash)` → inserted
    as a leaf into an on-chain **`intentsTree`** Merkle tree.
- **Privacy — owner ≠ authorizer:** splits `ownerAddress` (holds funds, e.g. a
  public Safe) from `authorizerAddress` (an anonymous **stealth authorizer** that
  posts intents). `authorizerDigest` salts/hides the stealth address so the
  public Safe isn't linkable to its tx activity.
- **Circuit (`authType=2`) checks:** (1) prove `privateNullifyingKey` knowledge,
  (2) reconstruct `intentCommitment`, (3) prove it's in `intentsTreeRoot`,
  (4) `authorizerAddress` matches the registered `authorizerDigest`. Security:
  the intent binds to the specific input notes → can't be reused for another tx.
- **Flows:** stealth-authorizer setup → register `authorizerDigest`; intent
  creation via `generateIntent(publicIntentHash)`; execution via one ZK proof to
  `transact`.
- **Heavy "Stealth Authorizer Hygiene":** fund the stealth Safe only via a
  privacy-pool withdrawal (cryptographic break), use standard thresholds
  (2/3, 3/5) to avoid fingerprinting, isolate signers on fresh HD paths, inject
  decoy multisigs + chaff intents, decorrelate deployment timing.

### Option B — In-circuit threshold signatures: FROST on BabyJubJub  *(THE BERMUDA WAY)*

M-of-N signers produce **one aggregate Schnorr signature**, verified **in-circuit**
against the registered public key. **Eliminates the on-chain intent step
entirely** (no `intentsTree`). ROAST (eprint 2022/550) adds async robustness.

The doc framed Option A as "first" (battle-tested Gnosis Safe infra, no BJJ
hardware-wallet support yet, no synchronous signing ceremony) and FROST as a
later coexisting `authType`. **The team is going with FROST anyway (Bermuda).**

---

## 2. The decision: "the Bermuda way" (FROST / Option B)

> "Bermuda multisigs are virtual accounts implemented with FROST signatures that
> are a composition of Schnorr signatures produced by individual Bermuda key
> pairs. Because of that modular inheritance our multisigs do not manifest as
> separate SDK account types. However, we are soon releasing utility functions to
> perform multisig setup, signing, and related functionality."

What this means:

- **Which option:** this is **Option B (FROST in-circuit threshold Schnorr)**,
  the doc's Section 8 — **not** intent-based `authType = 2`. No `intentsTree`, no
  stealth authorizer, no on-chain intent step.
- **Underlying primitive:** **signature-based authorization** (BabyJubJub Schnorr
  verified against the registered pubkey — the doc's "Key isolation" note), not
  v2.0's hash-preimage `authType = 0`. The nullifying key is provided separately;
  the BJJ private key is never a circuit input.
- **Why no separate account type:** a FROST aggregate Schnorr signature is
  indistinguishable from a single-signer Schnorr signature. The
  protocol/SDK/circuit just see "a valid signature from this account's pubkey."
  The multisig-ness lives entirely in the **signing layer**.
- **Status:** setup/signing **utility functions are "soon"** (not yet released).
  Nothing to integrate today; nothing to block on.

---

## 3. The *other* "intents" — DeFi/cross-chain (HackMD) — unrelated

"Intents: State of the art" is about **cross-chain swaps/bridging/execution** via
intent **aggregators/solvers** (recommends **Li.Fi**), with a 4-tier rollout
(A: use Li.Fi SDK → D: fully custom solver+aggregator). It's a research note.

- Different problem from multisig auth-intents: this is DeFi execution routing,
  not authorization.
- **Relevance to Payroll:** this is the track that could eventually make
  **multi-chain payouts** real (paying employees on Base/Arbitrum/etc.). It's why
  the Payroll network picker shows those as **"soon" + disabled** today.
- Could that team help with auth-intents (Option A)? Only conceptually — the
  Li.Fi/solver work doesn't produce the `intentsTree`/circuit, and their model is
  *not* privacy-preserving (solvers see intents) whereas auth-intents require
  owner↔authorizer unlinkability. Moot anyway since the team chose FROST.

---

## 4. Implications for the Payroll app

- **No multisig-specific code is needed.** Because Bermuda multisigs are virtual
  accounts that don't manifest as separate SDK account types, "whatever wallet is
  connected" already covers single keys **and** future Bermuda multisigs.
- Payroll **Pay** reuses the existing **private-transfer** flow (prefilled);
  **Fund** reuses the existing **deposit** modal. Neither assumes a single signer
  — both go through the SDK account/pool session, which a FROST multisig
  satisfies transparently.
- Keep the **single connected-wallet model** and the **"soon" network tags**
  (cross-chain payouts depend on the separate intents/Li.Fi track).
- When the Bermuda multisig utilities ship, they slot into the **connect/sign**
  path under the hood — no Payroll redesign expected; at most, surface
  setup helpers.

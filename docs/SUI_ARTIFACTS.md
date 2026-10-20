# Sui circuit artifacts

The in-browser Groth16 prover serves circuit artifacts (witness-generator wasm +
proving key + verification key) from `public/artifacts/`. These artifacts MUST
match the verifying keys (VKs) registered on the deployed Sui contracts, or
proofs built in the browser will fail to verify on-chain.

The URL resolver is `config/sui-circuits.ts` (`getSuiCircuitUrls`). It expects,
per circuit `<type>`:

```
public/artifacts/<type>/<type>_js/<type>.wasm   witness generator
public/artifacts/<type>/groth16_pkey.zkey       Groth16 proving key
public/artifacts/<type>/groth16_vkey.json       verification key
```

where `<type>` is `deposit`, `ragequit`, or `transact_NxM` (N inputs, M outputs,
each in `1..5`; 25 configs total).

## The provenance issue (why this doc/script exist)

The Sui deployment registers VKs from two DIFFERENT circuit sets
(see `ppv2-sui-v2-sync/scripts/register-vks.mjs`):

- **deposit / ragequit** -> the **native v2** circuits in
  `v2-monorepo/packages/circuits/build/{deposit,ragequit}` (loaded via
  `ORIGINAL_CIRCUITS`). Deposit has 3 public inputs, ragequit has 7; both fit
  the Sui `groth16` native 8-input limit, so no wrapper is needed.
- **transact_NxM (all 25, including 1x1)** -> the **SuiTransact wrapper**
  circuits in `ppv2-sui-v2-sync/circuits/build_sui/sui_transact_NxM` (loaded via
  `SUI_CIRCUITS`). The wrapper hashes all `6+N+M` public inputs into a single
  `publicInputHash` field element (1 public input) to fit the 8-input limit.

The artifact set that was previously committed under `public/artifacts/` was
WRONG for transact: it served the **native** v2 transact circuits (`6+N+M`
public inputs), not the SuiTransact wrappers (1 public input). Those proofs can
never verify against the registered wrapper VKs. Verified at staging time:

- `transact_1x1` served wasm was ~3.2 MB (native) vs ~5.3 MB for the SuiTransact
  wrapper -- a different circuit.
- The served `deposit` zkey AND vkey both differed from the native source the
  contract registered (a different ceremony) -- so even deposit was suspect.

## Correct sources

| circuit       | source root (override env var)                                  |
|---------------|-----------------------------------------------------------------|
| deposit       | `SUI_NATIVE_CIRCUITS` (default `/Users/nh2/0xbow/v2-monorepo/packages/circuits/build`) `/deposit`   |
| ragequit      | `SUI_NATIVE_CIRCUITS` `/ragequit`                               |
| transact_NxM  | `SUI_WRAPPER_CIRCUITS` (default `/Users/nh2/0xbow/ppv2-sui-v2-sync/circuits/build_sui`) `/sui_transact_NxM` |

The staging script maps `sui_transact_NxM` -> `transact_NxM` and the
`sui_transact_NxM_js/sui_transact_NxM.wasm` -> `transact_NxM_js/transact_NxM.wasm`.

## Staging

```bash
# Defaults point at the local monorepo + ppv2-sui-v2-sync checkout.
./scripts/stage-sui-artifacts.sh

# Or override the source roots / destination:
SUI_NATIVE_CIRCUITS=/path/to/v2-monorepo/packages/circuits/build \
SUI_WRAPPER_CIRCUITS=/path/to/ppv2-sui-v2-sync/circuits/build_sui \
SUI_ARTIFACT_DEST=$PWD/public/artifacts \
  ./scripts/stage-sui-artifacts.sh
```

The script is idempotent and overwrites in place. It stages 81 files
(deposit + ragequit + 25 transact configs, 3 files each).

## Provenance check

After staging, confirm the served proving key matches the served (and on-chain
registered) verification key:

```bash
node scripts/verify-sui-artifacts.mjs
# sample more configs if desired:
VERIFY_SAMPLE="deposit,ragequit,transact_1x1,transact_3x3,transact_5x5" \
  node scripts/verify-sui-artifacts.mjs
```

It exports the VK from each staged `groth16_pkey.zkey` via
`snarkjs.zKey.exportVerificationKey` and compares it field-by-field to the
staged `groth16_vkey.json`. By default it samples `deposit` and `transact_1x1`
(zkey export is slow; sampling is sufficient to catch a ceremony/circuit
mismatch). A pass means a browser proof from the served zkey will verify against
the registered VK.

## Do not commit the binaries (~890 MB)

`public/artifacts/` is git-ignored (see `.gitignore`). Never commit the staged
binaries.

> Follow-up needed: an earlier (WRONG) artifact set is currently git-TRACKED
> under `public/artifacts/` (81 files, ~890 MB). The `.gitignore` rule does not
> untrack already-tracked files. Removing them is a separate task, intentionally
> NOT done here:
>
> ```bash
> git rm --cached -r public/artifacts   # untrack only; keeps the staged files on disk
> ```

## Production hosting

Don't ship ~890 MB in the web bundle. Host the staged artifacts on a CDN / object
store and point the resolver at it:

```bash
EXPO_PUBLIC_SUI_ARTIFACT_BASE_URL=https://cdn.example.com/ppv2-sui-artifacts
```

`config/sui-circuits.ts` reads this env var (`CIRCUIT_ARTIFACT_BASE_URL`,
trailing slash stripped) and resolves all artifact URLs against it instead of
same-origin `/artifacts`. Upload the same staged tree (`<type>/...`) to that
base URL.

#!/usr/bin/env bash
#
# stage-sui-artifacts.sh
#
# Stage the Groth16 circuit artifacts (wasm + proving key + verification key)
# that the in-browser prover serves from `public/artifacts/`, so that they MATCH
# the verifying keys registered on-chain by the Sui deployment.
#
# WHY THIS EXISTS
# ---------------
# The on-chain Sui contracts register:
#   - deposit / ragequit : the NATIVE v2 circuits from v2-monorepo
#                          (see ppv2-sui-v2-sync/scripts/register-vks.mjs ORIGINAL_CIRCUITS)
#   - transact_NxM (all 25) : the SuiTransact WRAPPER circuits
#                          (public inputs hashed -> 1 field element)
#                          from ppv2-sui-v2-sync/circuits/build_sui/sui_transact_NxM
#
# The artifacts previously committed under `public/artifacts/` for transact were
# the NATIVE v2 transact circuits (6+N+M public inputs) -- the WRONG circuits.
# Proofs built from those would not verify against the registered wrapper VKs.
# The served deposit zkey/vkey were also from a different ceremony than the
# registered native deposit VK. This script copies the CORRECT sources into the
# exact layout the resolver (config/sui-circuits.ts) expects.
#
# SERVED LAYOUT (per config/sui-circuits.ts getSuiCircuitUrls):
#   public/artifacts/<type>/<type>_js/<type>.wasm   witness generator wasm
#   public/artifacts/<type>/groth16_pkey.zkey       Groth16 proving key
#   public/artifacts/<type>/groth16_vkey.json       verification key
#   where <type> is "deposit", "ragequit", or "transact_NxM".
#
# SOURCE -> DEST MAPPING:
#   NATIVE_SRC/deposit/deposit_js/deposit.wasm        -> deposit/deposit_js/deposit.wasm
#   NATIVE_SRC/deposit/groth16_pkey.zkey              -> deposit/groth16_pkey.zkey
#   NATIVE_SRC/deposit/groth16_vkey.json              -> deposit/groth16_vkey.json
#   NATIVE_SRC/ragequit/ragequit_js/ragequit.wasm     -> ragequit/ragequit_js/ragequit.wasm
#   NATIVE_SRC/ragequit/groth16_pkey.zkey             -> ragequit/groth16_pkey.zkey
#   NATIVE_SRC/ragequit/groth16_vkey.json             -> ragequit/groth16_vkey.json
#   SUI_SRC/sui_transact_NxM/sui_transact_NxM_js/sui_transact_NxM.wasm
#                                                     -> transact_NxM/transact_NxM_js/transact_NxM.wasm
#   SUI_SRC/sui_transact_NxM/groth16_pkey.zkey        -> transact_NxM/groth16_pkey.zkey
#   SUI_SRC/sui_transact_NxM/groth16_vkey.json        -> transact_NxM/groth16_vkey.json
#
# The staged files overwrite in place. They are git-ignored (see .gitignore);
# never commit the ~890 MB binary set.
#
set -euo pipefail

# --- Configurable source roots (env vars with sensible defaults) -------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Native v2 circuits (deposit, ragequit) -- the source register-vks.mjs uses.
NATIVE_SRC="${SUI_NATIVE_CIRCUITS:-/Users/nh2/0xbow/v2-monorepo/packages/circuits/build}"
# SuiTransact wrapper circuits (all 25 NxM).
SUI_SRC="${SUI_WRAPPER_CIRCUITS:-/Users/nh2/0xbow/ppv2-sui-v2-sync/circuits/build_sui}"
# Destination served root.
DEST="${SUI_ARTIFACT_DEST:-${REPO_ROOT}/public/artifacts}"

echo "stage-sui-artifacts: native (deposit/ragequit) source : ${NATIVE_SRC}"
echo "stage-sui-artifacts: wrapper (transact)        source : ${SUI_SRC}"
echo "stage-sui-artifacts: destination                      : ${DEST}"
echo

staged_count=0

# copy_one <src_file> <dest_file>
copy_one() {
  local src="$1"
  local dst="$2"
  if [ ! -f "${src}" ]; then
    echo "ERROR: missing source file: ${src}" >&2
    exit 1
  fi
  mkdir -p "$(dirname "${dst}")"
  cp -f "${src}" "${dst}"
  staged_count=$((staged_count + 1))
}

# --- Native circuits: deposit, ragequit --------------------------------------
for type in deposit ragequit; do
  echo "staging ${type} (native v2 circuit)"
  copy_one "${NATIVE_SRC}/${type}/${type}_js/${type}.wasm" "${DEST}/${type}/${type}_js/${type}.wasm"
  copy_one "${NATIVE_SRC}/${type}/groth16_pkey.zkey"       "${DEST}/${type}/groth16_pkey.zkey"
  copy_one "${NATIVE_SRC}/${type}/groth16_vkey.json"       "${DEST}/${type}/groth16_vkey.json"
done

# --- Transact wrapper circuits: all 25 NxM (1..5 x 1..5) ---------------------
for n in 1 2 3 4 5; do
  for m in 1 2 3 4 5; do
    src_name="sui_transact_${n}x${m}"
    dst_type="transact_${n}x${m}"
    echo "staging ${dst_type} (SuiTransact wrapper)"
    copy_one "${SUI_SRC}/${src_name}/${src_name}_js/${src_name}.wasm" "${DEST}/${dst_type}/${dst_type}_js/${dst_type}.wasm"
    copy_one "${SUI_SRC}/${src_name}/groth16_pkey.zkey"               "${DEST}/${dst_type}/groth16_pkey.zkey"
    copy_one "${SUI_SRC}/${src_name}/groth16_vkey.json"               "${DEST}/${dst_type}/groth16_vkey.json"
  done
done

echo
echo "stage-sui-artifacts: staged ${staged_count} files into ${DEST}"
echo "stage-sui-artifacts: layout -> deposit, ragequit, transact_1x1 .. transact_5x5"
echo
echo "Next: run scripts/verify-sui-artifacts.mjs to confirm each served zkey"
echo "      matches its served vkey (the VK registered on-chain)."

#!/usr/bin/env node
/**
 * verify-sui-artifacts.mjs
 *
 * Provenance check for the staged Sui circuit artifacts.
 *
 * For each sampled circuit, exports the verification key from the STAGED
 * proving key (groth16_pkey.zkey) and compares it field-by-field against the
 * STAGED verification key (groth16_vkey.json). If they match, the served zkey
 * is internally consistent with the served vkey -- and since the served vkey is
 * (by construction of stage-sui-artifacts.sh) the same file registered on-chain,
 * a proof produced from the served zkey will verify against the registered VK.
 *
 * Sampled (not all 25 -- zkey export is slow): deposit, transact_1x1.
 * Override the sample with: VERIFY_SAMPLE="deposit,transact_1x1,ragequit,transact_3x3"
 *
 * Usage:
 *   node scripts/verify-sui-artifacts.mjs
 *   VERIFY_ARTIFACT_DEST=/path/to/public/artifacts node scripts/verify-sui-artifacts.mjs
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as snarkjs from 'snarkjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DEST = process.env.VERIFY_ARTIFACT_DEST || join(REPO_ROOT, 'public', 'artifacts');
const SAMPLE = (process.env.VERIFY_SAMPLE || 'deposit,transact_1x1')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Normalize a snarkjs verification key for stable comparison. snarkjs may emit
// numbers/strings inconsistently; compare the proof-relevant fields only.
function normalizeVK(vk) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v === null || v === undefined) return v;
    return String(v);
  };
  return {
    protocol: String(vk.protocol),
    curve: String(vk.curve),
    nPublic: String(vk.nPublic),
    vk_alpha_1: norm(vk.vk_alpha_1),
    vk_beta_2: norm(vk.vk_beta_2),
    vk_gamma_2: norm(vk.vk_gamma_2),
    vk_delta_2: norm(vk.vk_delta_2),
    IC: norm(vk.IC),
  };
}

async function checkOne(type) {
  const zkeyPath = join(DEST, type, 'groth16_pkey.zkey');
  const vkeyPath = join(DEST, type, 'groth16_vkey.json');

  const servedVK = JSON.parse(await readFile(vkeyPath, 'utf8'));
  const derivedVK = await snarkjs.zKey.exportVerificationKey(zkeyPath);

  const a = JSON.stringify(normalizeVK(servedVK));
  const b = JSON.stringify(normalizeVK(derivedVK));

  if (a === b) {
    console.log(`  OK   ${type}: served vkey matches vkey derived from served zkey (nPublic=${servedVK.nPublic})`);
    return true;
  }
  console.error(`  FAIL ${type}: served vkey does NOT match the vkey derived from served zkey`);
  console.error(`       served zkey : ${zkeyPath}`);
  console.error(`       served vkey : ${vkeyPath}`);
  return false;
}

async function main() {
  console.log(`verify-sui-artifacts: dest=${DEST}`);
  console.log(`verify-sui-artifacts: sample=[${SAMPLE.join(', ')}]`);
  console.log();

  let allOk = true;
  for (const type of SAMPLE) {
    try {
      const ok = await checkOne(type);
      allOk = allOk && ok;
    } catch (err) {
      allOk = false;
      console.error(`  ERROR ${type}: ${err.message}`);
    }
  }

  console.log();
  if (allOk) {
    console.log('verify-sui-artifacts: PASS -- sampled served zkeys are consistent with their served vkeys.');
    process.exit(0);
  } else {
    console.error('verify-sui-artifacts: FAIL -- re-run scripts/stage-sui-artifacts.sh from the correct sources.');
    process.exit(1);
  }
}

main();

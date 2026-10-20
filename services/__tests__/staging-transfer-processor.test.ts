// The relayed-TRANSFER processor on the staging chains.
//
// The relayer runs two DIFFERENT on-chain routes (relayer
// `evm.chain.service.ts`): a withdrawal goes relayer EOA →
// PrivacyPoolRelay.relay() → PoolVault.transact (msg.sender = the relay
// contract), while a transfer is posted DIRECTLY from the relayer's signer EOA
// — and `simulateAndWriteRelayTransfer` OVERWRITES `transactParams.processor`
// with that EOA. PoolVault binds `keccak256(abi.encode(transactParams,
// noteData))` into the proof context, so a transfer proof bound to the relay
// contract can only revert with PoolVault_ProofContextMismatch, after the user
// has already paid ~30s of proving. That is exactly what chain 10 did while
// `relayerSigner` was unset and getTransferProcessorAddress fell back to
// `staging.relay`.
//
// These pin the split so the fallback cannot silently come back.

import { describe, expect, test } from 'bun:test';
import { STAGING_CHAINS } from '@/config/staging-deployments';
import { supportsColdStartClaim, VERIFIED_COLD_START_RELAYS } from '@/config/cold-start';

// Recovered from the relayer's own EIP-712 fee commitments on chains 1, 4114
// and 10 (2026-08-20) — see the STAGING_RELAYER_SIGNER note in the config.
const RELAYER_SIGNER = '0x9e2f1b234953f46c6091636290e9035618ea3c07';

describe('staging relayed-transfer processor', () => {
  test('every staging chain carries the relayer signer EOA', () => {
    expect(STAGING_CHAINS.length).toBeGreaterThan(0);
    for (const d of STAGING_CHAINS) {
      expect(d.relayerSigner?.toLowerCase()).toBe(RELAYER_SIGNER);
    }
  });

  test('the transfer processor is never the chain relay contract', () => {
    for (const d of STAGING_CHAINS) {
      // getTransferProcessorAddress(chainId) resolves to `relayerSigner ??
      // relay`; the fallback is the bug, so the two must never coincide.
      expect(d.relayerSigner?.toLowerCase()).not.toBe(d.relay.toLowerCase());
    }
  });
});

// The other half of the cold-start demo on chain 10: even once the private send
// lands, the recipient can only CLAIM gaslessly if its relay is on the
// allow-list. Verified on-chain 2026-08-20 — relay 0x55DC6ADe… carries
// `registerAndRelay`, the keystore impl behind `pool.keystore()` carries
// `setAuthPolicyWithSig`, and the relayer serves the chain-10 route.
describe('cold-start claim allow-list', () => {
  const OP_RELAY = '0x55DC6ADe57F3243c659cFe045F591C011924fECc';

  test('chain 10 is verified for the gasless claim', () => {
    expect(VERIFIED_COLD_START_RELAYS[10]).toContain(OP_RELAY);
    expect(supportsColdStartClaim(10, OP_RELAY)).toBe(true);
  });

  test('it stays keyed on the relay — an older relay on chain 10 is refused', () => {
    expect(supportsColdStartClaim(10, '0x' + '1'.repeat(40))).toBe(false);
  });
});

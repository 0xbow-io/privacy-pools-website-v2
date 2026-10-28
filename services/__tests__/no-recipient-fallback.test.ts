// An empty recipient blocks; it never resolves to the connected wallet (or the
// Sui / Stellar account). The wallet that deposited is the one address a
// payout must not default to: it links the deposit and the withdrawal on
// chain. Unit tests for the resolver, then source guards per surface, because
// the bug was a one-line `: connectedAddress` that no unit test could see.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAddress } from 'viem';
import { explicitRecipient, RECIPIENT_REQUIRED_MESSAGE } from '../explicit-recipient';

const root = join(new URL('.', import.meta.url).pathname, '..', '..');
const src = (p: string) => readFileSync(join(root, p), 'utf8');
const code = (p: string) => src(p).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const WALLET = '0x71c2000000000000000000000000000000009fa3';
const OTHER = '0x' + 'b'.repeat(40);
const evm = (a: string) => isAddress(a);

describe('explicitRecipient', () => {
  test('empty, blank and invalid input have no recipient', () => {
    for (const v of ['', '   ', null, undefined, 'vitalik.eth', '0x123']) expect(explicitRecipient(v, evm)).toBeNull();
  });
  test('a typed address is used as typed (trimmed), including your own wallet', () => {
    expect(explicitRecipient(`  ${OTHER} `, evm)).toBe(OTHER);
    expect(explicitRecipient(WALLET, evm)).toBe(WALLET);
  });
  test('takes no fallback: the signature has exactly two parameters', () => {
    expect(explicitRecipient.length).toBe(2);
  });
  test('the block message is plain copy', () => {
    expect(RECIPIENT_REQUIRED_MESSAGE).not.toMatch(/—/);
    expect(RECIPIENT_REQUIRED_MESSAGE.length).toBeLessThan(60);
  });
});

describe('Withdraw: empty recipient blocks, never the connected wallet', () => {
  const f = 'components/withdraw-modal-provider.tsx';
  const text = code(f);
  test('no resolution falls back to connectedAddress / altAccount / the Sui account', () => {
    expect(text).not.toMatch(/:\s*connectedAddress\s*;/);
    expect(text).not.toMatch(/reviewRecipientFallback/);
    expect(text).not.toMatch(/recipient\s*\|\|\s*altAccount/);
    expect(text).not.toMatch(/recipient\s*\|\|\s*\(?\s*suiSession\.account/);
    expect(text).not.toMatch(/\?\s*targetAddress\s*:\s*altAccount/);
  });
  test('every resolution site goes through explicitRecipient and refuses an empty one', () => {
    // Review (EVM), Review (Sui/Stellar), Confirm (EVM), Confirm (Stellar), Confirm (Sui).
    expect((text.match(/explicitRecipient\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect((text.match(/RECIPIENT_REQUIRED_MESSAGE/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(text).toMatch(/const resolvedRecipient = explicitRecipient\(targetAddress/);
  });
  test('the Sui/Stellar CTA is disabled without a recipient', () => {
    expect(text).toMatch(/isSui\s*\?\s*\(spendabilityLoading \|\| enteredAmount <= 0 \|\| !targetAddress/);
  });
  test('the Sui direct path (pays the signer) only runs when the signer is the recipient', () => {
    expect(text).toMatch(/!SUI_TESTNET_RELAYER_URL && !suiPaysSelf/);
  });
});

describe('Send: no fallback to the connected wallet', () => {
  const text = code('components/transfer-modal-provider.tsx');
  test('the only connectedAddress recipient is the consolidation (a private send to yourself)', () => {
    // recipientAccountRef tracks WHICH account is signed in (to reset the form), not a payee.
    const hits = (text.match(/\b[a-z][A-Za-z]*Recipient\s*=\s*[^;\n]*connectedAddress/g) ?? []);
    expect(hits).toEqual(['prefilledRecipient = forcedFromPrefill ? connectedAddress']);
    expect(text).not.toMatch(/(recipient|Recipient)(Address|Input)?\s*(\|\||\?\?)\s*(connectedAddress|walletAddress|sessionAddress)/);
  });
});

describe('Swap: the far-side fallback is never pre-filled with the wallet', () => {
  const text = code('components/swap-modal-provider.tsx');
  test('the field is never seeded or reset to the connected wallet', () => {
    expect(text).not.toMatch(/setRecipient\([^)]*(sessionAddress|address)\s*\|\|/);
    expect(text).not.toMatch(/\|\|\s*(sessionAddress|address)\s*\|\|\s*''\)/);
    expect(text).not.toMatch(/editRecipient\(\s*sessionAddress/);
  });
  test('a cross-chain reshield fallback is the typed address only', () => {
    expect(text).not.toMatch(/trimmedRecipient\s*\|\|\s*address/);
    expect(text).toMatch(/fallbackForReview = \(requestSendTo \? address : trimmedRecipient\)/);
    // canReview still refuses a cross-chain reshield without a valid address.
    expect(text).toMatch(/isReshield \? \(!crossChainReshield \|\| recipientValid\)/);
  });
});

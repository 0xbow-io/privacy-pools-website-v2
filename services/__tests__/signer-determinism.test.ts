import { describe, expect, test } from 'bun:test';
import { connectorIsKnownDeterministicSigner, contractWalletVerdict, isKnownDeterministicSigner } from '@/services/signer-determinism';

describe('contractWalletVerdict', () => {
  test('no code is an EOA', () => {
    expect(contractWalletVerdict(undefined)).toBe('eoa');
    expect(contractWalletVerdict('0x')).toBe('eoa');
  });
  test('an EIP-7702 delegation still signs as an EOA', () => {
    expect(contractWalletVerdict('0xef0100' + '11'.repeat(20))).toBe('delegated-eoa');
    expect(contractWalletVerdict('0xEF0100' + '22'.repeat(20))).toBe('delegated-eoa');
  });
  test('any other code is a contract wallet', () => {
    expect(contractWalletVerdict('0x6080604052')).toBe('contract');
  });
});

describe('isKnownDeterministicSigner', () => {
  test('MetaMask and Rabby by EIP-6963 id', () => {
    expect(isKnownDeterministicSigner({ id: 'io.metamask' })).toBe(true);
    expect(isKnownDeterministicSigner({ id: 'io.rabby' })).toBe(true);
  });
  test('the legacy injected connector by name or provider flag', () => {
    expect(isKnownDeterministicSigner({ id: 'injected', name: 'MetaMask' })).toBe(true);
    expect(isKnownDeterministicSigner({ id: 'injected', name: 'Rabby Wallet' })).toBe(true);
    expect(isKnownDeterministicSigner({ id: 'injected', name: 'Browser Wallet', flags: { isRabby: true } })).toBe(true);
    // isMetaMask is self-reported by many wallets: it grants nothing.
    expect(isKnownDeterministicSigner({ id: 'injected', name: 'Browser Wallet', flags: { isMetaMask: true } })).toBe(false);
  });
  test('everything else must prove itself', () => {
    expect(isKnownDeterministicSigner({ id: 'walletConnect', name: 'WalletConnect' })).toBe(false);
    expect(isKnownDeterministicSigner({ id: 'io.ambire', name: 'Ambire' })).toBe(false);
    expect(isKnownDeterministicSigner({ id: 'injected', name: 'Browser Wallet', flags: { isMetaMask: 'yes' } })).toBe(false);
    expect(isKnownDeterministicSigner({})).toBe(false);
  });
});

describe('connectorIsKnownDeterministicSigner', () => {
  test('reads provider flags, tolerates a failing getProvider, and no connector is untrusted', async () => {
    expect(await connectorIsKnownDeterministicSigner({ id: 'injected', name: 'Browser Wallet', getProvider: async () => ({ isRabby: true }) })).toBe(true);
    expect(await connectorIsKnownDeterministicSigner({ id: 'injected', name: 'Browser Wallet', getProvider: async () => { throw new Error('no provider'); } })).toBe(false);
    expect(await connectorIsKnownDeterministicSigner({ id: 'io.metamask', getProvider: async () => { throw new Error('no provider'); } })).toBe(true);
    expect(await connectorIsKnownDeterministicSigner(null)).toBe(false);
  });
});

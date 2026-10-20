import { describe, expect, test } from 'bun:test';

import {
  GENERIC_EXPLORER_LABEL,
  explorerLabel,
  viewOnExplorerLabel,
} from '@/services/explorer-label';

describe('explorer label', () => {
  test('names the chain the user is actually on', () => {
    // The bug: a Citrea withdrawal offered "View on Etherscan" beside a link to
    // explorer.mainnet.citrea.xyz (Pat, 2026-09-01).
    expect(explorerLabel(4114)).toBe('Citrea Explorer');
    expect(viewOnExplorerLabel(4114)).toBe('View on Citrea Explorer');
    expect(explorerLabel(1)).toBe('Etherscan');
    expect(explorerLabel(11155111)).toBe('Etherscan');
    expect(explorerLabel(56)).toBe('BscScan');
  });

  test('Optimism is NOT Etherscan, though its explorer is hosted on that domain', () => {
    // The case that justifies preferring viem over reading the hostname:
    // OP's explorer lives at optimistic.etherscan.io but is not called Etherscan.
    expect(explorerLabel(10)).toBe('Optimism Explorer');
    expect(explorerLabel(10, 'https://optimistic.etherscan.io')).toBe('Optimism Explorer');
  });

  test('falls back to the URL domain for a chain not in the viem table', () => {
    expect(explorerLabel(999999, 'https://basescan.org')).toBe('Basescan');
    expect(explorerLabel(999999, 'https://sepolia.etherscan.io/tx/0xabc')).toBe('Etherscan');
    expect(explorerLabel(null, 'https://explorer.mainnet.citrea.xyz')).toBe('Citrea Explorer');
    expect(explorerLabel(null, 'https://testnet.suivision.xyz')).toBe('SuiVision');
  });

  test('tolerates a bare host with no scheme, which config makes easy to write', () => {
    expect(explorerLabel(null, 'etherscan.io')).toBe('Etherscan');
    expect(explorerLabel(null, 'www.bscscan.com/tx/0x1')).toBe('BscScan');
  });

  test('degrades to the generic label rather than naming the wrong explorer', () => {
    // Every one of these must be neutral. Guessing a brand here would put
    // another chain's name next to a link that does not go there.
    for (const bad of [null, undefined, '', '   ', 'not a url', 'https://', 'localhost']) {
      expect(explorerLabel(null, bad as string | null)).toBe(GENERIC_EXPLORER_LABEL);
    }
    expect(explorerLabel(424242, 'https://some-unknown-explorer.example')).toBe(GENERIC_EXPLORER_LABEL);
    expect(viewOnExplorerLabel(null, null)).toBe('View on Explorer');
  });

  test('never throws, whatever it is handed', () => {
    const inputs = [null, undefined, '', '://', 'http://', '..', 'a.b.c.d.e', 'HTTPS://ETHERSCAN.IO'];
    for (const i of inputs) {
      expect(typeof explorerLabel(null, i as string | null)).toBe('string');
    }
    // Case-insensitive on the host, since config casing is not guaranteed.
    expect(explorerLabel(null, 'HTTPS://ETHERSCAN.IO')).toBe('Etherscan');
  });
});

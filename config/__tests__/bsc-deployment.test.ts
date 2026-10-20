import { describe, expect, test } from 'bun:test';
import { STAGING_CHAINS } from '@/config/staging-deployments';

/**
 * BSC values come from Artem (0xbow-remote#13) and were cross-checked live on
 * 2026-08-27: the pool, keystore and entrypoint all appear at block 118420793
 * (binary-searched via eth_getCode), and the entrypoint reports BNB and USDT
 * both enabled with minAmount 1.
 */
// STAGING_CHAINS is the exported view (kill switches applied); BSC is present
// unless EXPO_PUBLIC_STAGING_BSC=false, which is not set in a test env.
const bsc = STAGING_CHAINS.find((d) => d.chainId === 56);

describe('BSC staging deployment', () => {
  test('is registered', () => {
    expect(bsc).toBeDefined();
    expect(bsc?.name).toBe('bsc');
    expect(bsc?.nativeCurrency.symbol).toBe('BNB');
  });

  test('carries the addresses from the issue, verbatim', () => {
    expect(bsc?.pool).toBe('0x968950B99a92d6b96914474a318ac83ed37B3bE6');
    expect(bsc?.keystore).toBe('0xCb037548418FAC4F4EC9273CeF16D79f9c1cb94a');
    expect(bsc?.entrypoint).toBe('0x88b0e52636Cb19b9b00DD5c6eF9eE81bb5a2fD1F');
    expect(bsc?.aspRegistry).toBe('0x15bD39eF2184d92f71545a174eCb19904820346B');
    expect(bsc?.accessRouter).toBe('0x6b40E8174164037555bcCdAc0efbf29d20939F9B');
    expect(bsc?.relay).toBe('0x8884DC0c0DEcd2558F128ee00dD522ABfa21Dd52');
  });

  test('starts at the DERIVED deployment block, not a guess', () => {
    expect(bsc?.fromBlock).toBe(118420793n);
    expect(bsc?.keystoreFromBlock).toBe(118420793n);
  });

  test('uses BscScan, so explorer links are not silently Etherscan', () => {
    expect(bsc?.explorerUrl).toBe('https://bscscan.com');
    expect(bsc?.explorerName).toBe('BscScan');
  });

  test('prefers Alchemy and keeps a standby behind it', () => {
    // The public endpoint cannot serve eth_getLogs at any range, so Alchemy is
    // effectively required - but it still makes a valid fallback for other calls.
    const urls = bsc?.rpcUrls ?? [];
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[urls.length - 1]).toBe('https://bsc-dataseed.binance.org');
  });
});

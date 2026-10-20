import { describe, test, expect, mock } from 'bun:test';

// config transitively pulls react-native — stub the one symbol needed, the
// leak-safe way (never mock '@/config/env' itself; see note-receipt.test.ts).
mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_PAY_URL_BASE = 'https://pay.example.test';
process.env.EXPO_PUBLIC_TEST_MODE = 'true';

const { listShieldPools, defaultPoolFor, resolveDepositDestination, resolveDepositPayAsset, plainNativeDepositRefused } = await import('@/services/shield-pools');
const { supportedChainIds, defaultChainId } = await import('@/config/chains');
const { getKnownTokenMetadata, NATIVE_ASSET_ADDRESS: NATIVE_SENTINEL } = await import('@/config/tokens');

// The pure destination rule, exercised with a stubbed VERIFIED prod vault: the
// unit suite runs staging and never runs the on-chain probe, so the real
// resolvers answer "no vault" here and the duplicate-row bug cannot reproduce
// through them. These pin the rule itself.
const USDC = { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, isNative: false, withdrawOnly: true as const };
const PPUSDC = { symbol: 'ppUSDC', address: '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6', decimals: 18, isNative: false };
const ETH = { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18, isNative: true };
const registry: Record<string, typeof PPUSDC> = { [PPUSDC.address.toLowerCase()]: PPUSDC };
const knownMeta = (address: string) => registry[address.toLowerCase()];
const vaultFor = (_chainId: number, address: string) =>
  (address.toLowerCase() === USDC.address.toLowerCase() ? { ppUSDC: PPUSDC.address } : undefined);
const noVault = () => undefined;

describe('deposit destination: a yield underlying lands in its SHARE pool', () => {
  test('USDC with a verified vault resolves to ppUSDC, so the picker shows ONE row per pool', () => {
    expect(resolveDepositDestination(USDC, 1, vaultFor, knownMeta)?.symbol).toBe('ppUSDC');
    // The share itself is its own destination: the underlying-only resolver
    // does not answer for a share address, so both inputs converge on one pool.
    expect(resolveDepositDestination(PPUSDC, 1, vaultFor, knownMeta)?.symbol).toBe('ppUSDC');
  });

  test('without a verified vault a withdraw-only asset has NO destination (the Entrypoint reverts it)', () => {
    expect(resolveDepositDestination(USDC, 1, noVault, knownMeta)).toBeNull();
  });

  test('a verified vault whose share the registry does not know yields null, never the closed pool', () => {
    expect(resolveDepositDestination(USDC, 1, vaultFor, () => undefined)).toBeNull();
  });

  test('an ordinary asset is its own destination', () => {
    expect(resolveDepositDestination(ETH, 1, vaultFor, knownMeta)?.symbol).toBe('ETH');
  });
});

describe('deposit pay asset: a SHARE named as the deposit is paid as its underlying', () => {
  // The share <-> underlying resolver the modal uses (getYieldDeploymentForAsset
  // answers for either side of a verified vault).
  const vaultForAsset = (_chainId: number, address: string) => {
    const a = address.toLowerCase();
    return a === USDC.address.toLowerCase() || a === PPUSDC.address.toLowerCase()
      ? { ppUSDC: PPUSDC.address, underlying: USDC.address }
      : undefined;
  };
  const registryBoth: Record<string, typeof PPUSDC | typeof USDC> = {
    [PPUSDC.address.toLowerCase()]: PPUSDC,
    [USDC.address.toLowerCase()]: USDC,
  };
  const knownBoth = (address: string) => registryBoth[address.toLowerCase()];

  // The registry flags a share as one (config/environments.ts aaveShare); the
  // stub carries the same flag so the unverified branch can be recognised.
  const PPUSDC_SHARE = { ...PPUSDC, yieldShare: 'aave-v3' as const };

  test('"deposit ppUSDC" (pool page, deep link) is paid with USDC - the wallet never holds the share', () => {
    // Matthew, prod 2026-09-05: the modal resolved ppUSDC literally, read a
    // wallet ppUSDC balance of 0 and refused the USDC deposit. The whole
    // metadata is asserted: address and decimals feed the balance read.
    expect(resolveDepositPayAsset(PPUSDC_SHARE, 1, vaultForAsset, knownBoth)).toEqual(USDC);
  });

  test('the underlying and every ordinary asset are paid as themselves', () => {
    expect(resolveDepositPayAsset(USDC, 1, vaultForAsset, knownBoth)).toEqual(USDC);
    expect(resolveDepositPayAsset(ETH, 1, vaultForAsset, knownBoth)).toEqual(ETH);
  });

  test('a NATIVE-MODE share (ppETH) is paid with the chain\'s coin, never with its WETH underlying', () => {
    // The hub names the destination pool (ppETH) since 2026-09-18; the router
    // wraps msg.value itself and WETH is no registry asset, so resolving the
    // underlying refused every ETH shield (codex on dd034a1).
    const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const PPETH_SHARE = { symbol: 'ppETH', address: '0x66051920D25af4E3596A8a46309F4D045F9D83B7', decimals: 18, isNative: false, yieldShare: 'aave-v3' as const };
    const nativeVault = (_chainId: number, address: string) =>
      (address.toLowerCase() === PPETH_SHARE.address.toLowerCase() ? { ppUSDC: PPETH_SHARE.address, underlying: WETH, nativeMode: true } : undefined);
    const registryNoWeth: Record<string, typeof ETH | typeof PPETH_SHARE> = {
      [ETH.address.toLowerCase()]: ETH,
      [PPETH_SHARE.address.toLowerCase()]: PPETH_SHARE,
    };
    expect(resolveDepositPayAsset(PPETH_SHARE, 1, nativeVault, (a) => registryNoWeth[a.toLowerCase()])).toEqual(ETH);
    // A build with no native coin registered on that chain still refuses rather than paying the share.
    expect(resolveDepositPayAsset(PPETH_SHARE, 1, nativeVault, (a) => (a.toLowerCase() === PPETH_SHARE.address.toLowerCase() ? PPETH_SHARE : undefined))).toBeNull();
  });

  test('an UNVERIFIED share is refused (null), never paid as itself', () => {
    // Codex P2 on 7421944: opening the ppUSDC pool's deposit before the vault
    // probe answered stored the share as the payment token, and nothing
    // re-resolved it once the probe turned ok - the original bug for the life
    // of that open. Refusing with a retry message is the honest answer.
    expect(resolveDepositPayAsset(PPUSDC_SHARE, 1, noVault, knownBoth)).toBeNull();
  });

  test('a verified share whose underlying the registry does not know is refused too', () => {
    expect(resolveDepositPayAsset(PPUSDC_SHARE, 1, vaultForAsset, () => undefined)).toBeNull();
  });
});

describe('shield-pools', () => {
  test('lists at least one pool on the default chain, and never one that cannot take a deposit', () => {
    const pools = listShieldPools();
    expect(pools.length).toBeGreaterThan(0);
    expect(pools.some((p) => p.chainId === defaultChainId)).toBe(true);
    // A pool whose deposits have not opened yet (mainnet ETH,
    // `depositComingSoon`) is not a destination: it may be SHOWN in a picker,
    // disabled, but nothing may default or convert into it.
    for (const p of pools) {
      expect(getKnownTokenMetadata(p.address, p.chainId)?.depositComingSoon).toBeUndefined();
    }
  });

  test('mainnet ETH is listed as a pool asset but not as a shield destination', () => {
    // The asset stays in the registry - existing notes are real and spendable -
    // while the deposit-shaped directory drops it (2026-09-05).
    expect(getKnownTokenMetadata(NATIVE_SENTINEL, 1)?.depositComingSoon).toBe(true);
    expect(listShieldPools().some((p) => p.chainId === 1 && p.symbol === 'ETH')).toBe(false);
    expect(resolveDepositDestination({ ...ETH, depositComingSoon: true as const }, 1, noVault, knownMeta)).toBeNull();
  });

  test('rule 1: same-token pool on the same chain wins', () => {
    const pool = defaultPoolFor('USDC', 11155111);
    expect(pool.chainId).toBe(11155111);
    expect(pool.symbol).toBe('USDC');
  });

  test('rule 2: no same-token pool falls to the chain native pool', () => {
    // A token with no pool on sepolia (arbitrary wallet holding).
    const pool = defaultPoolFor('WIF', 11155111);
    expect(pool.chainId).toBe(11155111);
    expect(pool.symbol).toBe('ETH');
  });

  test('rule 3: an unsupported chain falls to Ethereum (or the default native pool)', () => {
    const pool = defaultPoolFor('ETH', 999999);
    if (supportedChainIds.includes(1)) {
      expect(pool.chainId).toBe(1);
      // Ethereum's own ETH pool while it takes deposits; once it is
      // `depositComingSoon` the rule falls through to a mainnet pool that can
      // actually receive one, never to a dead end.
      expect(pool.symbol).toBe(getKnownTokenMetadata(NATIVE_SENTINEL, 1)?.depositComingSoon ? 'USDC' : 'ETH');
    } else {
      expect(pool.chainId).toBe(defaultChainId);
    }
  });

  test('every listed pool round-trips through the default rule as rule 1', () => {
    for (const p of listShieldPools()) {
      const d = defaultPoolFor(p.symbol, p.chainId);
      expect(d.chainId).toBe(p.chainId);
      expect(d.symbol).toBe(p.symbol);
    }
  });
});

describe('deposit destination: the native coin lands in the native-mode SHARE pool (ppETH, 2026-09-18)', () => {
  const PPETH = { symbol: 'ppETH', address: '0x66051920D25af4E3596A8a46309F4D045F9D83B7', decimals: 18, isNative: false };
  const knownWithPpeth = (address: string) =>
    address.toLowerCase() === PPETH.address.toLowerCase() ? PPETH : knownMeta(address);
  const nativeRoute = () => ({ ppUSDC: PPETH.address });
  const noNativeRoute = () => undefined;

  test('ETH with a configured native route resolves to ppETH, not the plain ETH pool', () => {
    expect(resolveDepositDestination(ETH, 1, noVault, knownWithPpeth, nativeRoute)?.symbol).toBe('ppETH');
  });
  test('without a native route ETH is its own destination, as before', () => {
    expect(resolveDepositDestination(ETH, 1, noVault, knownWithPpeth, noNativeRoute)?.symbol).toBe('ETH');
    expect(resolveDepositDestination(ETH, 1, noVault, knownWithPpeth)?.symbol).toBe('ETH');
  });
  test('a native route whose share the registry does not know is null, never the legacy pool', () => {
    expect(resolveDepositDestination(ETH, 1, noVault, knownMeta, nativeRoute)).toBeNull();
  });
  test('an ERC-20 asset ignores the native route', () => {
    expect(resolveDepositDestination(USDC, 1, vaultFor, knownWithPpeth, nativeRoute)?.symbol).toBe('ppUSDC');
  });
});

describe('plainNativeDepositRefused', () => {
  test('native coin + configured route + not going through it = refused', () => {
    expect(plainNativeDepositRefused({ isNative: true, nativeRouteConfigured: true, viaYieldRoute: false })).toBe(true);
  });
  test('through the router, an ERC-20, or a chain with no native route all pass', () => {
    expect(plainNativeDepositRefused({ isNative: true, nativeRouteConfigured: true, viaYieldRoute: true })).toBe(false);
    expect(plainNativeDepositRefused({ isNative: false, nativeRouteConfigured: true, viaYieldRoute: false })).toBe(false);
    expect(plainNativeDepositRefused({ isNative: true, nativeRouteConfigured: false, viaYieldRoute: false })).toBe(false);
  });
});

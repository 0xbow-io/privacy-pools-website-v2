// The cross-chain swap-and-deposit support matrix (SDK ≥ eecb069b,
// v2-monorepo#372). Every condition below is a deployment fact, and the
// staging LiFi networks are Ethereum (1), OP Mainnet (10), Base (8453), and
// BNB Chain (56). Citrea (4114) and Sepolia (11155111) are NOT, so no LiFi
// contract-calls route can bridge into or out of them no matter what
// contracts we deploy there.
import { describe, expect, mock, test } from 'bun:test';

// config transitively pulls react-native — stub the one symbol needed, the
// leak-safe way (same pattern as services/__tests__/shield-pools.test.ts).
mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_ASP_URL = 'https://asp.example.test';
process.env.EXPO_PUBLIC_INTENT_SWAPS = 'true';
// This file is about the ROUTING matrix, so it runs with the intent lockdown
// lifted (config/intent-lockdown.ts hides the whole surface on prod while LiFi
// cannot route the yield shares). The lockdown itself is covered by
// config/__tests__/intent-lockdown.test.ts.
process.env.EXPO_PUBLIC_INTENT_LOCKDOWN = 'false';

const {
  crossChainReshieldSupported,
  getSwapDestinationChains,
  crossChainSwapDepositSupported,
  intentSwapsEnabledForChain,
  lifiServesChain,
  swapDepositEnabledForChain,
  getSwapInputTokens,
  getSwapOutputTokens,
  getSwapProcessorAddress,
} = await import('@/config/intent-swaps');

const ETHEREUM = 1;
const OPTIMISM = 10;
const BASE = 8453;
const BSC = 56;
const CITREA = 4114;
const SEPOLIA = 11155111;

describe('staging BNB cross-chain routes', () => {
  for (const peer of [ETHEREUM, OPTIMISM, BASE]) {
    for (const [source, destination] of [[BSC, peer], [peer, BSC]]) {
      test(`${source} → ${destination}: private swaps and wallet-funded shields are available`, () => {
        expect(getSwapDestinationChains(source)).toContain(destination);
        expect(crossChainReshieldSupported(source, destination)).toBe(true);
        expect(crossChainSwapDepositSupported(source, destination)).toBe(true);
      });
    }
  }
});

describe('lifiServesChain', () => {
  test('only the chains LiFi actually serves', () => {
    expect(lifiServesChain(ETHEREUM)).toBe(true);
    expect(lifiServesChain(OPTIMISM)).toBe(true);
    // Verified against li.quest/v1/chains — neither appears there.
    expect(lifiServesChain(CITREA)).toBe(false);
    expect(lifiServesChain(SEPOLIA)).toBe(false);
  });
});

describe('crossChainSwapDepositSupported', () => {
  test('Ethereum → Optimism stays routable', () => {
    // Both ends are LiFi networks with an on-chain-verified RelaySwaps, and the
    // OP entrypoint's assets are configured (SWAP_OUTPUT_TOKENS[10]).
    expect(crossChainSwapDepositSupported(ETHEREUM, OPTIMISM)).toBe(true);
  });

  test('Optimism → Ethereum is routable now that mainnet declares swap outputs', () => {
    // This direction used to fail closed purely because SWAP_OUTPUT_TOKENS had
    // no chain-1 entry. Mainnet's three configured entrypoint assets (verified
    // on-chain 2026-08-18: vettingFeeBPS 100, minimumDepositAmount 1) closed
    // that gap, and nothing about LiFi or the deployments ever blocked it.
    expect(crossChainSwapDepositSupported(OPTIMISM, ETHEREUM)).toBe(true);
  });

  test('mainnet is a full swap chain in both directions of the matrix', () => {
    // The same table drives flow 1 and flow 2 on mainnet itself — the relayer
    // serves chain-1 swap quotes, so leaving these off would hide a working
    // route.
    expect(swapDepositEnabledForChain(ETHEREUM)).toBe(true);
    expect(intentSwapsEnabledForChain(ETHEREUM)).toBe(true);
  });

  test('same-chain is not a cross-chain route (that is ordinary flow 1)', () => {
    expect(crossChainSwapDepositSupported(ETHEREUM, ETHEREUM)).toBe(false);
    expect(crossChainSwapDepositSupported(OPTIMISM, OPTIMISM)).toBe(false);
  });

  test('Citrea is excluded at BOTH ends — a RelaySwaps there cannot help', () => {
    // Citrea has pools and its own relay, but LiFi does not serve it, and
    // flow 1 IS a LiFi contract-calls transaction.
    expect(crossChainSwapDepositSupported(CITREA, ETHEREUM)).toBe(false);
    expect(crossChainSwapDepositSupported(ETHEREUM, CITREA)).toBe(false);
    expect(crossChainSwapDepositSupported(CITREA, OPTIMISM)).toBe(false);
    expect(crossChainSwapDepositSupported(OPTIMISM, CITREA)).toBe(false);
  });

  test('Sepolia is excluded at both ends for the same reason', () => {
    expect(crossChainSwapDepositSupported(SEPOLIA, OPTIMISM)).toBe(false);
    expect(crossChainSwapDepositSupported(OPTIMISM, SEPOLIA)).toBe(false);
    expect(crossChainSwapDepositSupported(SEPOLIA, ETHEREUM)).toBe(false);
    expect(crossChainSwapDepositSupported(ETHEREUM, SEPOLIA)).toBe(false);
  });

  test('an unknown chain is never routable', () => {
    expect(crossChainSwapDepositSupported(42161, OPTIMISM)).toBe(false);
    expect(crossChainSwapDepositSupported(OPTIMISM, 42161)).toBe(false);
  });
});

describe('crossChainReshieldSupported', () => {
  // The flag is read at call time, so both states are testable in one file —
  // a module-load constant would be frozen at whatever the first import saw.
  const withFlag = <T>(value: string | undefined, fn: () => T): T => {
    const previous = process.env.EXPO_PUBLIC_RESHIELD_CROSSCHAIN;
    if (value === undefined) delete process.env.EXPO_PUBLIC_RESHIELD_CROSSCHAIN;
    else process.env.EXPO_PUBLIC_RESHIELD_CROSSCHAIN = value;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.EXPO_PUBLIC_RESHIELD_CROSSCHAIN;
      else process.env.EXPO_PUBLIC_RESHIELD_CROSSCHAIN = previous;
    }
  };

  test('ON by default — this build is private staging, so a working capability is reachable', () => {
    // The gate below still refuses everything that cannot work, so "on" is only
    // ever the routable pairs.
    withFlag(undefined, () => {
      expect(crossChainReshieldSupported(ETHEREUM, OPTIMISM)).toBe(true);
      expect(crossChainReshieldSupported(OPTIMISM, ETHEREUM)).toBe(true);
    });
    withFlag('', () => expect(crossChainReshieldSupported(ETHEREUM, OPTIMISM)).toBe(true));
  });

  test('an explicit false is the kill switch', () => {
    withFlag('false', () => expect(crossChainReshieldSupported(ETHEREUM, OPTIMISM)).toBe(false));
    withFlag('0', () => expect(crossChainReshieldSupported(ETHEREUM, OPTIMISM)).toBe(false));
  });

  test('ON: both LiFi chains, source RelaySwaps, destination outputs', () => {
    // Whether the RELAYER will quote the source chain is runtime state this
    // cannot see — chain 1 answers today, chain 10 returns 500.
    withFlag('true', () => {
      expect(crossChainReshieldSupported(ETHEREUM, OPTIMISM)).toBe(true);
      expect(crossChainReshieldSupported(OPTIMISM, ETHEREUM)).toBe(true);
    });
  });

  test('ON: same chain is flow 3, not flow 4', () => {
    withFlag('true', () => {
      expect(crossChainReshieldSupported(ETHEREUM, ETHEREUM)).toBe(false);
      expect(crossChainReshieldSupported(OPTIMISM, OPTIMISM)).toBe(false);
    });
  });

  test('ON: a chain this build does not serve is excluded', () => {
    // Arbitrum is a LiFi network with no deployment of ours, so the build-serves
    // clause is what refuses it. That clause reads STAGING_BY_CHAIN rather than
    // getChainConfig on purpose — importing config/chains here adds a load-order
    // edge that froze an env-derived constant elsewhere and broke two unrelated
    // golden accounting tests. If someone "simplifies" it back, this stays green
    // but the full-suite baseline moves, so the comment matters as much as this.
    withFlag('true', () => {
      expect(crossChainReshieldSupported(42161, OPTIMISM)).toBe(false);
      expect(crossChainReshieldSupported(OPTIMISM, 42161)).toBe(false);
    });
  });

  test('ON: OP and Base reach each other now that Base has a RelaySwaps', () => {
    // A reshield needs RelaySwaps on the SOURCE, so Base out only opened once the
    // staging relayer published one for 8453.
    withFlag('true', () => {
      expect(crossChainReshieldSupported(OPTIMISM, BASE)).toBe(true);
      expect(crossChainReshieldSupported(BASE, OPTIMISM)).toBe(true);
    });
  });

  test('ON: a non-LiFi chain is still excluded at either end', () => {
    // The bridge leg is a LiFi route, so no deployment of ours can help here.
    withFlag('true', () => {
      expect(crossChainReshieldSupported(CITREA, ETHEREUM)).toBe(false);
      expect(crossChainReshieldSupported(ETHEREUM, CITREA)).toBe(false);
      expect(crossChainReshieldSupported(SEPOLIA, OPTIMISM)).toBe(false);
      expect(crossChainReshieldSupported(OPTIMISM, SEPOLIA)).toBe(false);
      expect(crossChainReshieldSupported(42161, OPTIMISM)).toBe(false);
    });
  });
});

describe('getSwapDestinationChains', () => {
  test('a LiFi chain with swaps on offers itself plus the other LiFi chain', () => {
    // Source first (a plain same-chain withdraw-and-swap), then what a
    // cross-chain delivery can reach. This is the switch the swap modal's
    // destination pane keys off, so a regression here silently removes the
    // feature from the UI rather than breaking anything loudly.
    expect(getSwapDestinationChains(ETHEREUM)).toEqual([ETHEREUM, OPTIMISM, BASE, BSC]);
    expect(getSwapDestinationChains(OPTIMISM)).toEqual([OPTIMISM, ETHEREUM, BASE, BSC]);
  });

  test('staging BNB uses its own processor and offers every staging swap chain', () => {
    expect(lifiServesChain(BSC)).toBe(true);
    expect(getSwapProcessorAddress(BSC)?.toLowerCase()).toBe('0xbe16948700c538d71599db99df604a2ea9a7e61a');
    expect(intentSwapsEnabledForChain(BSC)).toBe(true);
    expect(getSwapDestinationChains(BSC)).toEqual([BSC, ETHEREUM, OPTIMISM, BASE]);
    expect(swapDepositEnabledForChain(BSC)).toBe(true);
  });

  test('bridged staging swaps land in ERC20 pools, never plain native pools', () => {
    expect(getSwapInputTokens(BSC).map((token) => token.symbol)).toEqual(['BNB', 'USDT']);
    expect(getSwapOutputTokens(BSC, OPTIMISM)).toEqual([
      { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, isNative: false, name: 'Tether USD' },
    ]);
    expect(getSwapOutputTokens(OPTIMISM, BSC).map((token) => token.symbol)).toEqual(['USDC', 'USDT']);
    // Same-chain native conversions retain their existing deposit path.
    expect(getSwapOutputTokens(BSC, BSC).map((token) => token.symbol)).toEqual(['BNB', 'USDT']);
  });

  test('a non-LiFi chain can only deliver to itself', () => {
    // The delivery leg is a LiFi route, so Citrea and Sepolia have no
    // cross-chain destinations no matter what we deploy there.
    expect(getSwapDestinationChains(CITREA)).toEqual([CITREA]);
    expect(getSwapDestinationChains(SEPOLIA)).toEqual([SEPOLIA]);
  });

  test('an unknown chain gets no destinations but itself', () => {
    expect(getSwapDestinationChains(42161)).toEqual([42161]);
  });

  test('a chain switched off for this deployment is never advertised', () => {
    // EXPO_PUBLIC_DISABLED_CHAIN_IDS removes a chain from the app's config, so
    // offering it as a destination would point at a chain nothing else can
    // resolve. Read at module load, so this asserts the parsed set is consulted
    // rather than re-parsing per call — with no var set, both stay on offer.
    expect(process.env.EXPO_PUBLIC_DISABLED_CHAIN_IDS ?? '').toBe('');
    expect(getSwapDestinationChains(ETHEREUM)).toContain(OPTIMISM);
  });
});

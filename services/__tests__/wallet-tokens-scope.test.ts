// services/wallet-tokens.ts's chain-scope constants, evaluated from source
// with mocked config dependencies (same technique as asp-affordances.test.ts)
// so a keyless build (no ALCHEMY_KEY) can be exercised without a DOM or a
// real Alchemy key.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = (path: string) => ts.createSourceFile(path,
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function evaluate(code: string, env: Record<string, unknown>) {
  return new Function(...Object.keys(env), ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText)(...Object.values(env));
}

const walletTokens = source('services/wallet-tokens.ts');
const code = walletTokens.statements.filter((n) => !ts.isImportDeclaration(n))
  .map((n) => n.getText(walletTokens).replace(/^export /, '')).join('\n');

function scopeConstants(env: {
  alchemyKey: string;
  chainIds: number[];
  testnetIds: number[];
  customRpcIds: number[];
}) {
  const isTestnetChain = (id: number) => env.testnetIds.includes(id);
  const usesCustomRpc = (id: number) => env.customRpcIds.includes(id);
  return evaluate(
    `${code}; return { WALLET_TOKEN_CHAIN_IDS, WALLET_TOKEN_MAINNET_IDS, ALCHEMY_WALLET_CHAIN_IDS, ONCHAIN_WALLET_CHAIN_IDS, HOLDINGS_ONLY_CHAIN_IDS, WALLET_ROW_CHAIN_IDS };`,
    {
      ALCHEMY_KEY: env.alchemyKey,
      supportedEvmChainIds: env.chainIds,
      isTestnetChain,
      usesCustomRpc,
      getChainConfig: () => undefined,
      getActionableTokens: () => [],
      partitionSpamTokens: () => ({ suspicious: [] }),
    },
  ) as {
    WALLET_TOKEN_CHAIN_IDS: number[];
    WALLET_TOKEN_MAINNET_IDS: number[];
    ALCHEMY_WALLET_CHAIN_IDS: number[];
    ONCHAIN_WALLET_CHAIN_IDS: number[];
    HOLDINGS_ONLY_CHAIN_IDS: number[];
    WALLET_ROW_CHAIN_IDS: number[];
  };
}

// 1 = eth-mainnet (Alchemy), 56 = bnb-mainnet (Alchemy), 8901 = a chain
// Alchemy does not serve at all — only reachable through a custom RPC.
test('a keyless build still reads custom-RPC mainnets on-chain', () => {
  const scope = scopeConstants({
    alchemyKey: '', // no ALCHEMY_KEY at all
    chainIds: [1, 56, 8901],
    testnetIds: [],
    customRpcIds: [56, 8901],
  });
  // Alchemy is unreachable without a key, whatever the chain.
  expect(scope.WALLET_TOKEN_CHAIN_IDS).toEqual([]);
  expect(scope.ALCHEMY_WALLET_CHAIN_IDS).toEqual([]);
  // The custom-RPC mainnets must NOT disappear along with the Alchemy list:
  // this is the bug (codex P2) — deriving them FROM the Alchemy-gated set
  // silently dropped every custom-RPC chain in a keyless build.
  expect(scope.ONCHAIN_WALLET_CHAIN_IDS.slice().sort()).toEqual([56, 8901]);
  // ...and they must be in the verified-feed scope, or the on-chain read
  // above has no verified list to read against.
  expect(scope.WALLET_TOKEN_MAINNET_IDS.slice().sort()).toEqual([56, 8901]);
});

test('with a key, Alchemy chains and custom-RPC chains are both in scope, deduped', () => {
  const scope = scopeConstants({
    alchemyKey: 'a-real-key',
    chainIds: [1, 56, 11155111],
    testnetIds: [11155111],
    customRpcIds: [56],
  });
  expect(scope.WALLET_TOKEN_CHAIN_IDS.slice().sort((a, b) => a - b)).toEqual([1, 10, 56, 137, 8453, 42161, 11155111]);
  // 56 has a custom RPC, so it is read on-chain, not through Alchemy (11155111
  // stays on Alchemy: it has no custom RPC of its own).
  expect(scope.ALCHEMY_WALLET_CHAIN_IDS.slice().sort((a, b) => a - b)).toEqual([1, 10, 137, 8453, 42161, 11155111]);
  expect(scope.ONCHAIN_WALLET_CHAIN_IDS).toEqual([56]);
  // Mainnets only (11155111 is a testnet) — 1 from Alchemy, 56 from custom
  // RPC, no duplicate entry for 56.
  expect(scope.WALLET_TOKEN_MAINNET_IDS.slice().sort((a, b) => a - b)).toEqual([1, 10, 56, 137, 8453, 42161]);
});

test('an ordinary build with no custom RPC at all is unchanged', () => {
  const scope = scopeConstants({
    alchemyKey: 'a-real-key',
    chainIds: [1, 10, 11155111],
    testnetIds: [11155111],
    customRpcIds: [],
  });
  expect(scope.ALCHEMY_WALLET_CHAIN_IDS.slice().sort((a, b) => a - b)).toEqual([1, 10, 56, 137, 8453, 42161, 11155111]);
  expect(scope.ONCHAIN_WALLET_CHAIN_IDS).toEqual([]);
  expect(scope.WALLET_TOKEN_MAINNET_IDS.slice().sort((a, b) => a - b)).toEqual([1, 10, 56, 137, 8453, 42161]);
});

// DEV-521: prod pools live on Ethereum, BNB Chain and Citrea only, and ETH on
// Optimism never reached the Shield picker because only pool chains were
// scanned.
test('a mainnet build scans the major no-pool chains too, a pool chain is not duplicated', () => {
  const scope = scopeConstants({ alchemyKey: 'k', chainIds: [1, 56, 4114], testnetIds: [], customRpcIds: [] });
  expect(scope.HOLDINGS_ONLY_CHAIN_IDS.slice().sort((a, b) => a - b)).toEqual([10, 137, 8453, 42161]);
  expect(scope.WALLET_TOKEN_CHAIN_IDS).toContain(10);
  // Mainnets, so they get LiFi's verified list and the spam rules.
  expect(scope.WALLET_TOKEN_MAINNET_IDS).toContain(10);
  // Staging with an OP pool: OP is a pool chain, not holdings-only.
  const staging = scopeConstants({ alchemyKey: 'k', chainIds: [1, 10], testnetIds: [], customRpcIds: [] });
  expect(staging.HOLDINGS_ONLY_CHAIN_IDS).not.toContain(10);
  expect(staging.WALLET_TOKEN_CHAIN_IDS.filter((id) => id === 10)).toEqual([10]);
});

test('a testnet-only build scans no mainnet', () => {
  const scope = scopeConstants({ alchemyKey: 'k', chainIds: [11155111], testnetIds: [11155111], customRpcIds: [] });
  expect(scope.HOLDINGS_ONLY_CHAIN_IDS).toEqual([]);
  expect(scope.WALLET_TOKEN_CHAIN_IDS).toEqual([11155111]);
});

// Review on #235: a holdings-only chain has no catalog, and the fallback
// catalog's USDC address flagged the real USDC on Base as an impersonator.
test('the spam rules on a holdings-only chain get no fallback catalog', () => {
  const seen: unknown[][] = [];
  const mark = evaluate(`${code}; return markSuspiciousTokens;`, {
    ALCHEMY_KEY: 'k',
    supportedEvmChainIds: [1, 56],
    isTestnetChain: (id: number) => ![1, 56].includes(id), // unknown ids fail closed, as in config/chains
    usesCustomRpc: () => false,
    getChainConfig: () => undefined,
    getActionableTokens: () => [{ symbol: 'USDC', address: '0xa0b8' }],
    partitionSpamTokens: (_t: unknown, known: unknown[]) => { seen.push(known); return { suspicious: [] }; },
  }) as (tokens: unknown[], chainId: number, verified: null) => unknown[];
  mark([], 8453, null);
  mark([], 1, null);
  expect(seen).toEqual([[], [{ symbol: 'USDC', address: '0xa0b8' }]]);
});

// Mike on #276: Robinhood Chain (4663) holdings come from Alchemy like the
// other prod chains (network "robinhood-mainnet"), not dropped from the picker.
test('prod: every new chain is in the Alchemy holdings scope', () => {
  const scope = scopeConstants({
    alchemyKey: 'k',
    chainIds: [1, 4114, 56, 10, 8453, 42161, 4663],
    testnetIds: [],
    customRpcIds: [],
  });
  for (const id of [10, 8453, 42161, 4663]) {
    expect(scope.ALCHEMY_WALLET_CHAIN_IDS).toContain(id);
    expect(scope.WALLET_ROW_CHAIN_IDS).toContain(id);
    expect(scope.WALLET_TOKEN_MAINNET_IDS).toContain(id);
  }
  expect(scope.ONCHAIN_WALLET_CHAIN_IDS).toEqual([]);
  expect(scope.WALLET_ROW_CHAIN_IDS).not.toContain(4114);
});

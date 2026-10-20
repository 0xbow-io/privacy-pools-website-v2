import { describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));

const { fetchWalletTokensOnChain } = await import('@/services/wallet-tokens-onchain');
const { markSuspiciousTokens } = await import('@/services/wallet-tokens');

const OWNER = '0x1111111111111111111111111111111111111111';
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const LINK = '0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd';
const HELD_BYTES32 = '0x2222222222222222222222222222222222222222';
const EMPTY = '0x3333333333333333333333333333333333333333';

type Call = { address: string; functionName: string; args?: unknown[] };

function fakeReader(balances: Record<string, bigint>, metadata: Record<string, { symbol: unknown; decimals: unknown; name: unknown }>) {
  const calls: Call[][] = [];
  return {
    calls,
    reader: {
      getBalance: async () => 2n * 10n ** 18n,
      multicall: async ({ contracts }: { contracts: Call[] }) => {
        calls.push(contracts);
        return contracts.map((c) => {
          if (c.functionName === 'balanceOf') return { status: 'success', result: balances[c.address] ?? 0n };
          const value = metadata[c.address]?.[c.functionName as 'symbol' | 'decimals' | 'name'];
          return value === undefined ? { status: 'failure', error: new Error('revert') } : { status: 'success', result: value };
        });
      },
    },
  };
}

describe('fetchWalletTokensOnChain', () => {
  test('asks balanceOf of every verified token for the owner, and metadata only of the held ones', async () => {
    const { reader, calls } = fakeReader(
      { [LINK]: 5n * 10n ** 18n, [HELD_BYTES32]: 1n },
      {
        [LINK]: { symbol: 'LINK', decimals: 18, name: 'ChainLink Token' },
        // A real bytes32-symbol ERC-20: the metadata read SUCCEEDS (valid
        // decimals and name), but `symbol` decodes to something other than a
        // string — the case this fixture must cover, not a failed read.
        [HELD_BYTES32]: { symbol: new Uint8Array([0x4c, 0x49, 0x4e, 0x4b]), decimals: 18, name: 'Old Token' },
      },
    );
    const tokens = await fetchWalletTokensOnChain(OWNER, 56, 'https://node.example', new Set([NATIVE, LINK, HELD_BYTES32, EMPTY]), reader as never);

    expect(calls[0].map((c) => [c.address, c.functionName, c.args?.[0]])).toEqual([
      [LINK, 'balanceOf', OWNER], [HELD_BYTES32, 'balanceOf', OWNER], [EMPTY, 'balanceOf', OWNER],
    ]);
    expect(new Set(calls[1].map((c) => c.address))).toEqual(new Set([LINK, HELD_BYTES32]));
    // The native coin comes from getBalance; a held bytes32 token with a
    // non-string symbol is skipped even though its metadata read succeeded.
    expect(tokens.map((t) => [t.symbol, t.address, t.balance, t.priceUnknown])).toEqual([
      ['BNB', NATIVE, 2n * 10n ** 18n, true],
      ['LINK', LINK, 5n * 10n ** 18n, true],
    ]);
  });

  test('rows read on-chain pass the spam rules on LiFi verification alone', async () => {
    const { reader } = fakeReader({ [LINK]: 1n }, { [LINK]: { symbol: 'LINK', decimals: 18, name: 'ChainLink Token' } });
    const tokens = await fetchWalletTokensOnChain(OWNER, 56, 'https://node.example', new Set([LINK]), reader as never);
    expect(markSuspiciousTokens(tokens, 56, new Set([NATIVE, LINK])).map((t) => [t.symbol, !!t.suspicious])).toEqual([
      ['BNB', false], ['LINK', false],
    ]);
    // Without the list nothing but configured assets passes, same as the Alchemy path.
    expect(markSuspiciousTokens(tokens, 56, null).find((t) => t.symbol === 'LINK')?.suspicious).toBe(true);
  });
});

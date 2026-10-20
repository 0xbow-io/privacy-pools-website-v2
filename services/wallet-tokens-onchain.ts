// Wallet holdings for a chain the user pointed at their own RPC. Alchemy's
// token API is not JSON-RPC, so it cannot travel through that endpoint; asking
// it anyway would tell Alchemy the address the user chose to keep from it.
//
// Instead every token LiFi verifies on the chain gets a `balanceOf` through the
// user's RPC (multicall3, egress-policed), and only the non-zero ones have
// their metadata read. The call set is the whole verified list for everyone,
// so it says nothing about what the wallet holds, and nothing unverified can
// appear.
import { createPublicClient, erc20Abi, type Address } from 'viem';

import { policedHttp } from '@/services/egress-transport';
import { nativeSymbolFor, type WalletToken } from '@/services/wallet-tokens';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

// aggregate3 calldata bytes per eth_call: roughly 290 balanceOf reads, a few
// million gas, well inside a node's eth_call cap. Ethereum's list is ~20 calls.
const BATCH_BYTES = 65_536;

type Reader = Pick<ReturnType<typeof createPublicClient>, 'getBalance' | 'multicall'>;

/** Non-zero holdings among `verified` on the chain behind `rpcUrl`, unsorted and unpriced. */
export async function fetchWalletTokensOnChain(
  ownerAddress: string,
  chainId: number,
  rpcUrl: string,
  verified: ReadonlySet<string>,
  reader: Reader = createPublicClient({ transport: policedHttp(rpcUrl) }),
): Promise<WalletToken[]> {
  const owner = ownerAddress as Address;
  const out: WalletToken[] = [];

  const native = await reader.getBalance({ address: owner });
  if (native > 0n) {
    const symbol = nativeSymbolFor(chainId);
    out.push({ symbol, name: symbol, address: NATIVE_SENTINEL, decimals: 18, balance: native, usdValue: null, priceUnknown: true });
  }

  const erc20 = [...verified].filter((a) => a !== NATIVE_SENTINEL) as Address[];
  const balances = await reader.multicall({
    contracts: erc20.map((address) => ({ address, abi: erc20Abi, functionName: 'balanceOf' as const, args: [owner] })),
    allowFailure: true,
    multicallAddress: MULTICALL3,
    batchSize: BATCH_BYTES,
  });
  const held: { address: Address; balance: bigint }[] = [];
  balances.forEach((entry, i) => {
    if (entry.status === 'success' && typeof entry.result === 'bigint' && entry.result > 0n) {
      held.push({ address: erc20[i], balance: entry.result });
    }
  });
  if (held.length === 0) return out;

  const fields = ['symbol', 'decimals', 'name'] as const;
  const metadata = await reader.multicall({
    contracts: held.flatMap(({ address }) => fields.map((functionName) => ({ address, abi: erc20Abi, functionName }))),
    allowFailure: true,
    multicallAddress: MULTICALL3,
    batchSize: BATCH_BYTES,
  });
  held.forEach(({ address, balance }, i) => {
    const [symbol, decimals, name] = fields.map((_, j) => metadata[i * fields.length + j]);
    // A token whose symbol is not a string (old bytes32 ones) is skipped rather than guessed.
    if (symbol?.status !== 'success' || typeof symbol.result !== 'string' || !symbol.result) return;
    if (decimals?.status !== 'success' || typeof decimals.result !== 'number' || decimals.result > 36) return;
    out.push({
      symbol: symbol.result,
      name: name?.status === 'success' && typeof name.result === 'string' && name.result ? name.result : symbol.result,
      address: address.toLowerCase(),
      decimals: decimals.result,
      balance,
      usdValue: null,
      priceUnknown: true,
    });
  });
  return out;
}

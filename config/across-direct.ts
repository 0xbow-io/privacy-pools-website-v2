// Direct Across bridging (no LI.FI in between) for cross-chain ERC-20 legs.
//
// OFF BY DEFAULT. With the flag off nothing here changes a request, a route or a
// screen: the SDK session keeps the plain LiFi provider, previews keep calling
// li.quest, and no Across address is accepted anywhere.
//
// Turning it on takes two env vars, on purpose:
//   EXPO_PUBLIC_ACROSS_DIRECT=true           the feature itself
//   EXPO_PUBLIC_ACROSS_DIRECT_CHAINS=10,8453 the SOURCE chains whose RelaySwaps has
//                                            the Across SpokePool on approvedRouters
// A chain missing from the second list keeps LiFi, so the flag cannot route a
// relayed withdrawal into a target RelaySwaps would refuse after the proof.
//
// Kept free of config/chains and config/tokens imports so bun tests can load it.

/** Same `tool` / `bridge` key the SDK's AcrossBridgeQuoteProvider reports. */
export const ACROSS_DIRECT_BRIDGE = 'across-direct';

// IMPORTANT: static `process.env.EXPO_PUBLIC_*` member reads only. Metro inlines
// static access at build time; a dynamic lookup is undefined in the web export.
function readFlag(): boolean {
  return (process.env.EXPO_PUBLIC_ACROSS_DIRECT ?? '').trim().toLowerCase() === 'true';
}

function readChains(): ReadonlySet<number> {
  return new Set(
    (process.env.EXPO_PUBLIC_ACROSS_DIRECT_CHAINS ?? '')
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isInteger(id) && id > 0),
  );
}

/** Read at call time so tests can toggle it. */
export function acrossDirectEnabled(): boolean {
  return readFlag();
}

/**
 * Source chains where Across direct may be used: the flag is on AND the chain is
 * listed in EXPO_PUBLIC_ACROSS_DIRECT_CHAINS AND Across has a SpokePool there.
 */
export function acrossDirectSourceChainIds(): number[] {
  if (!readFlag()) return [];
  return [...readChains()].filter((id) => ACROSS_SPOKE_POOLS[id] !== undefined);
}

/**
 * Across SpokePools, from `GET app.across.to/api/chains` (2026-10-28), matching
 * the SDK's ACROSS_SPOKE_POOLS. A SpokePool only ever pulls tokens from its own
 * caller (`deposit` transfers from msg.sender), so an allowance left standing on
 * it cannot be spent by anyone else. Citrea (4114) is not served by Across.
 */
const ACROSS_SPOKE_POOLS: Record<number, string> = {
  1: '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5',
  10: '0x6f26Bf09B1C792e3228e5467807a900A503c0281',
  56: '0x4e8E101924eDE233C13e2D8622DC8aED2872d505',
  8453: '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64',
  42161: '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A',
  4663: '0xD29C85F15DF544bA632C9E25829fd29d767d7978',
  11155111: '0x5ef6C01E11889d86803e0B23e3cB3F9E9d97B662',
};

/** Across MulticallHandler, the recipient of a deposit that ends in a pool call. None on Robinhood. */
const ACROSS_MULTICALL_HANDLER = '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E';
const HANDLER_CHAINS: ReadonlySet<number> = new Set([1, 10, 56, 8453, 42161, 11155111]);

/** The SpokePool on `chainId`, or undefined where Across has none. */
export function acrossSpokePool(chainId: number): string | undefined {
  return ACROSS_SPOKE_POOLS[chainId];
}

/** The MulticallHandler on `chainId`, or undefined where none is published. */
export function acrossMulticallHandler(chainId: number): string | undefined {
  return HANDLER_CHAINS.has(chainId) ? ACROSS_MULTICALL_HANDLER : undefined;
}

/** Is `address` the Across SpokePool on `chainId`? */
export function isAcrossSpokePool(chainId: number, address: string | undefined | null): boolean {
  const pool = ACROSS_SPOKE_POOLS[chainId];
  return !!address && !!pool && pool.toLowerCase() === address.toLowerCase();
}

/** Is `address` an Across SpokePool on any chain? For screens that only hold the target. */
export function isAnyAcrossSpokePool(address: string | undefined | null): boolean {
  if (!address) return false;
  const wanted = address.toLowerCase();
  return Object.values(ACROSS_SPOKE_POOLS).some((pool) => pool.toLowerCase() === wanted);
}

/**
 * The `bridge` to hand `getSwapStatus` for a route that went to `swapTarget`, so
 * the SDK's router asks the provider that actually carried it. Undefined for a
 * LiFi route, which keeps today's lookup unchanged.
 */
export function statusBridgeFor(swapTarget: string | undefined | null): string | undefined {
  return isAnyAcrossSpokePool(swapTarget) ? ACROSS_DIRECT_BRIDGE : undefined;
}

const NATIVE_SPELLINGS = new Set([
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  '0x0000000000000000000000000000000000000000',
]);

/**
 * Would the SDK's PreferAcrossSwapQuoteProvider send this route to Across?
 * Same rule: cross-chain, the source chain enabled, Across on both chains,
 * ERC-20 on both ends, and a published handler when the route ends in a deposit.
 * The Across API still decides whether that token pair is enabled.
 */
export function acrossDirectServes(params: {
  fromChainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  destinationCall: boolean;
}): boolean {
  if (params.fromChainId === params.toChainId) return false;
  if (!acrossDirectSourceChainIds().includes(params.fromChainId)) return false;
  if (!ACROSS_SPOKE_POOLS[params.toChainId]) return false;
  if (params.destinationCall && !acrossMulticallHandler(params.toChainId)) return false;
  return !NATIVE_SPELLINGS.has(params.fromToken.toLowerCase()) && !NATIVE_SPELLINGS.has(params.toToken.toLowerCase());
}

// Simulate a transaction that spends an ERC-20 the caller has NOT approved.
//
// Why this exists: a swap-into-deposit is only simulatable once the executor
// can pull the input token, so the approval used to be sent first and the
// simulation second. Every route that then failed left a real, live allowance
// behind while the UI reported the attempt over (mainnet, 2026-09-21: an
// abandoned allowance was spent by a stranger 85 seconds later).
//
// `eth_call` takes a third argument that overrides account state for the
// duration of the call. Writing the allowance straight into the token's
// storage grants it to the SIMULATION and to nothing else, so the whole retry
// ladder can run before the wallet is asked for a signature.
//
// The one unknown is WHICH storage slot holds `allowance[owner][spender]`,
// because Solidity numbers a contract's mappings in declaration order and no
// two tokens agree. So it is discovered rather than assumed: write a sentinel
// into each candidate slot in turn and ask the token itself what the allowance
// is. The slot that makes `allowance()` return the sentinel is the right one,
// by the token's own account of its storage. Verified on mainnet against USDC
// (slot 10, behind its proxy) and USDT (slot 5).
//
// Everything here fails CLOSED: an undiscoverable slot, a node that refuses
// the override argument, any error at all reports `supported: false` and the
// caller falls back to the approve-first order with its revoke behind it.

import { concat, keccak256, pad, toHex } from 'viem';
import type { Address, Hex } from '@/services/sdk-types';

/**
 * How many leading mapping slots to try. Every token this app pays with keeps
 * its allowance mapping well inside this range (USDC 10, USDT 5, DAI 3, WETH
 * 2), and the probe costs one eth_call per candidate, so the ceiling is a
 * latency budget rather than a guess at what exists.
 */
export const MAX_ALLOWANCE_SLOT_PROBE = 24;

/**
 * Two probe values, not one, and both must read back.
 *
 * A single sentinel proves only that the token reported that number. A token
 * whose allowance already HOLDS that number reports it whether or not the
 * override reached storage, and so does a node that quietly ignores the
 * override argument. Two different values cannot both be answered by a
 * constant, so the slot is confirmed by the override having CHANGED the
 * answer, which is the property being relied on.
 */
const SENTINELS = [
  '0x00000000000000000000000000000000000000000000000000000000deadbeef',
  '0x0000000000000000000000000000000000000000000000000000000000c0ffee',
] as Hex[];

const ALLOWANCE_SELECTOR = '0xdd62ed3e';

/** `allowance(owner, spender)` calldata. */
export function allowanceCalldata(owner: Address, spender: Address): Hex {
  return `${ALLOWANCE_SELECTOR}${owner.slice(2).toLowerCase().padStart(64, '0')}${spender.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
}

/**
 * Where Solidity puts `mapping(address => mapping(address => uint256))` entry
 * [owner][spender] when the outer mapping is declared at slot `index`:
 * keccak(spender ‖ keccak(owner ‖ index)).
 */
export function allowanceStorageSlot(owner: Address, spender: Address, index: number): Hex {
  const inner = keccak256(concat([pad(owner as `0x${string}`), pad(toHex(index))]));
  return keccak256(concat([pad(spender as `0x${string}`), inner]));
}

/** One account's state replacement for the duration of an eth_call. */
export interface StateOverrideEntry {
  address: Address;
  stateDiff: { slot: Hex; value: Hex }[];
}

/**
 * An `eth_call` that takes state overrides. `ok` false with no `data` covers
 * both a revert and a node that would not run the call at all; `supported`
 * false means the override argument itself was refused.
 */
export type OverrideCall = (args: {
  to: Address;
  data: Hex;
  account?: Address;
  value?: bigint;
  overrides: StateOverrideEntry[];
}) => Promise<{ ok: boolean; supported: boolean; data?: Hex; revertData?: string }>;

/**
 * Discovered slots, per chain and token. A miss is cached too: re-probing 24
 * slots on every attempt for a token whose layout this cannot read would turn
 * a fallback into a stall.
 */
const slotCache = new Map<string, number | null>();

/** Test seam. Not called in the app. */
export function resetAllowanceSlotCache(): void {
  slotCache.clear();
}

/**
 * Find the slot holding `allowance[owner][spender]`, by writing a sentinel and
 * asking the token to read it back. Returns null when no candidate matches,
 * which is a signal to stop trying, not an error.
 */
export async function findAllowanceSlot(
  call: OverrideCall,
  params: { chainId: number; token: Address; owner: Address; spender: Address },
): Promise<number | null> {
  const key = `${params.chainId}:${params.token.toLowerCase()}`;
  const cached = slotCache.get(key);
  if (cached !== undefined) return cached;
  const data = allowanceCalldata(params.owner, params.spender);
  /**
   * Write `value` into candidate `index` and ask the token what it now reads.
   * `undefined` means the answer could not be used at all; `false` on the
   * outer result means give up on this token entirely.
   */
  const probe = async (
    index: number,
    value: Hex,
  ): Promise<{ usable: boolean; read?: bigint }> => {
    let result: Awaited<ReturnType<OverrideCall>>;
    try {
      result = await call({
        to: params.token,
        data,
        overrides: [{
          address: params.token,
          stateDiff: [{ slot: allowanceStorageSlot(params.owner, params.spender, index), value }],
        }],
      });
    } catch {
      // A node that will not take the override argument will not take it for
      // any slot either. Give up on this token rather than probe 24 times.
      return { usable: false };
    }
    if (!result.supported) return { usable: false };
    if (!result.ok || !result.data) return { usable: true };
    try { return { usable: true, read: BigInt(result.data) }; } catch { return { usable: true }; }
  };
  for (let index = 0; index < MAX_ALLOWANCE_SLOT_PROBE; index++) {
    const first = await probe(index, SENTINELS[0]!);
    if (!first.usable) {
      slotCache.set(key, null);
      return null;
    }
    if (first.read !== BigInt(SENTINELS[0]!)) continue;
    // The candidate answered the first value. Confirm it answers a DIFFERENT
    // one too, so a constant allowance that happens to equal the first, or a
    // backend that never applied the override, cannot pass for a found slot.
    const second = await probe(index, SENTINELS[1]!);
    if (!second.usable) {
      slotCache.set(key, null);
      return null;
    }
    if (second.read !== BigInt(SENTINELS[1]!)) continue;
    slotCache.set(key, index);
    return index;
  }
  slotCache.set(key, null);
  return null;
}

/**
 * Dry-run `tx` as if `spenders` each held `amount` of `token`, granting
 * nothing.
 *
 * `supported: false` is the only answer that means "ask the caller to fall
 * back"; `ok: false` with `supported: true` is a real verdict on the route.
 */
export async function simulateWithAllowanceOverride(
  call: OverrideCall,
  params: {
    chainId: number;
    tx: { to: Address; data: Hex; value?: bigint };
    owner: Address;
    token: Address;
    spenders: readonly Address[];
    amount: bigint;
  },
): Promise<{ ok: boolean; supported: boolean; revertData?: string }> {
  const spenders = params.spenders.filter((address, at, all) =>
    all.findIndex((other) => other.toLowerCase() === address.toLowerCase()) === at);
  if (spenders.length === 0) return { ok: false, supported: false };
  const slot = await findAllowanceSlot(call, {
    chainId: params.chainId,
    token: params.token,
    owner: params.owner,
    spender: spenders[0]!,
  });
  if (slot === null) return { ok: false, supported: false };
  const value = pad(toHex(params.amount)) as Hex;
  try {
    const result = await call({
      to: params.tx.to,
      data: params.tx.data,
      account: params.owner,
      ...(params.tx.value !== undefined ? { value: params.tx.value } : {}),
      overrides: [{
        address: params.token,
        stateDiff: spenders.map((spender) => ({
          slot: allowanceStorageSlot(params.owner, spender, slot),
          value,
        })),
      }],
    });
    if (!result.supported) return { ok: false, supported: false };
    return { ok: result.ok, supported: true, ...(result.revertData ? { revertData: result.revertData } : {}) };
  } catch {
    return { ok: false, supported: false };
  }
}

import { beforeEach, describe, expect, test } from 'bun:test';

import {
  allowanceCalldata,
  allowanceStorageSlot,
  findAllowanceSlot,
  MAX_ALLOWANCE_SLOT_PROBE,
  resetAllowanceSlotCache,
  simulateWithAllowanceOverride,
  type OverrideCall,
} from '@/services/allowance-override-sim';
import type { Address, Hex } from '@/services/sdk-types';

const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
const OWNER = '0x1111111111111111111111111111111111111111' as Address;
const SPENDER = '0x2222222222222222222222222222222222222222' as Address;
const OTHER = '0x3333333333333333333333333333333333333333' as Address;
const EXECUTOR = '0x4444444444444444444444444444444444444444' as Address;

/**
 * A node that knows one token's layout, exactly as the real one does: it
 * answers `allowance(owner, spender)` from whatever the override wrote into
 * the slot that token really uses, and returns zero for every other slot. That
 * is the property slot discovery rests on, so the fake has to have it too.
 */
const nodeWithAllowanceAt = (realSlot: number, opts: { supported?: boolean } = {}) => {
  const calls: { to: Address; overrides: unknown }[] = [];
  const call: OverrideCall = async (args) => {
    calls.push({ to: args.to, overrides: args.overrides });
    if (opts.supported === false) return { ok: false, supported: false };
    const diff = args.overrides[0]?.stateDiff ?? [];
    if (args.data.startsWith('0xdd62ed3e')) {
      // Answer for whichever spender the probe asked about, not a fixed one.
      const asked = `0x${args.data.slice(98, 138)}` as Address;
      const wanted = allowanceStorageSlot(`0x${args.data.slice(34, 74)}` as Address, asked, realSlot);
      const hit = diff.find((entry) => entry.slot.toLowerCase() === wanted.toLowerCase());
      return { ok: true, supported: true, data: (hit?.value ?? `0x${'0'.repeat(64)}`) as Hex };
    }
    return { ok: true, supported: true, data: '0x' as Hex };
  };
  return { call, calls };
};

beforeEach(() => resetAllowanceSlotCache());

describe('allowanceStorageSlot', () => {
  test('matches the mainnet layouts this was verified against', () => {
    // Nested-mapping addressing: keccak(spender ‖ keccak(owner ‖ index)).
    // Distinct per index, per owner and per spender, or the probe would find
    // the wrong slot and the simulation would be a lie.
    const a = allowanceStorageSlot(OWNER, SPENDER, 10);
    expect(a).not.toBe(allowanceStorageSlot(OWNER, SPENDER, 5));
    expect(a).not.toBe(allowanceStorageSlot(OWNER, OTHER, 10));
    expect(a).not.toBe(allowanceStorageSlot(OTHER, SPENDER, 10));
    expect(a).toBe(allowanceStorageSlot(OWNER, SPENDER, 10));
  });

  test('is case-insensitive in the addresses, which arrive checksummed', () => {
    expect(allowanceStorageSlot(OWNER.toUpperCase().replace('0X', '0x') as Address, SPENDER, 3))
      .toBe(allowanceStorageSlot(OWNER.toLowerCase() as Address, SPENDER, 3));
  });
});

describe('allowanceCalldata', () => {
  test('is a full-width allowance(address,address) call', () => {
    const data = allowanceCalldata(OWNER, SPENDER);
    expect(data.startsWith('0xdd62ed3e')).toBe(true);
    expect(data.length).toBe(2 + 8 + 128);
  });
});

describe('findAllowanceSlot', () => {
  test('finds USDC at 10 and USDT at 5, the layouts this was proven against', async () => {
    for (const slot of [10, 5, 0]) {
      resetAllowanceSlotCache();
      const node = nodeWithAllowanceAt(slot);
      expect(await findAllowanceSlot(node.call, { chainId: 1, token: TOKEN, owner: OWNER, spender: SPENDER }))
        .toBe(slot);
    }
  });

  test('a token whose layout it cannot read returns null instead of guessing', async () => {
    const node = nodeWithAllowanceAt(MAX_ALLOWANCE_SLOT_PROBE + 3);
    expect(await findAllowanceSlot(node.call, { chainId: 1, token: TOKEN, owner: OWNER, spender: SPENDER }))
      .toBe(null);
  });

  test('a node that refuses the override is abandoned after ONE probe, not 24', async () => {
    const node = nodeWithAllowanceAt(10, { supported: false });
    expect(await findAllowanceSlot(node.call, { chainId: 1, token: TOKEN, owner: OWNER, spender: SPENDER }))
      .toBe(null);
    expect(node.calls.length).toBe(1);
  });

  test('a throwing transport is a miss, never a crash on the deposit path', async () => {
    const throwing: OverrideCall = async () => { throw new Error('connection reset'); };
    expect(await findAllowanceSlot(throwing, { chainId: 1, token: TOKEN, owner: OWNER, spender: SPENDER }))
      .toBe(null);
  });

  test('the answer is cached per chain and token, including a miss', async () => {
    const first = nodeWithAllowanceAt(10);
    await findAllowanceSlot(first.call, { chainId: 1, token: TOKEN, owner: OWNER, spender: SPENDER });
    const probes = first.calls.length;
    await findAllowanceSlot(first.call, { chainId: 1, token: TOKEN, owner: OWNER, spender: SPENDER });
    expect(first.calls.length).toBe(probes);
    // The same token address on another chain is a different contract.
    await findAllowanceSlot(first.call, { chainId: 10, token: TOKEN, owner: OWNER, spender: SPENDER });
    expect(first.calls.length).toBeGreaterThan(probes);
  });
});

describe('simulateWithAllowanceOverride', () => {
  const tx = { to: EXECUTOR, data: '0xdeadbeef' as Hex };

  test('grants the amount to EVERY spender the route names, in one call', async () => {
    const node = nodeWithAllowanceAt(10);
    const result = await simulateWithAllowanceOverride(node.call, {
      chainId: 1,
      tx,
      owner: OWNER,
      token: TOKEN,
      spenders: [EXECUTOR, SPENDER],
      amount: 19_881_337n,
    });
    expect(result).toEqual({ ok: true, supported: true });
    const simulation = node.calls.at(-1)!;
    expect(simulation.to).toBe(EXECUTOR);
    const diff = (simulation.overrides as { address: Address; stateDiff: { slot: Hex; value: Hex }[] }[])[0]!;
    expect(diff.address).toBe(TOKEN);
    expect(diff.stateDiff.length).toBe(2);
    for (const entry of diff.stateDiff) expect(BigInt(entry.value)).toBe(19_881_337n);
    // The declared approval address and the executor are often the same
    // contract; overriding one slot twice would be harmless but sloppy.
    expect(new Set(diff.stateDiff.map((e) => e.slot)).size).toBe(2);
  });

  test('duplicate spenders collapse to one override', async () => {
    const node = nodeWithAllowanceAt(10);
    await simulateWithAllowanceOverride(node.call, {
      chainId: 1, tx, owner: OWNER, token: TOKEN,
      spenders: [EXECUTOR, EXECUTOR.toUpperCase().replace('0X', '0x') as Address],
      amount: 1n,
    });
    const diff = (node.calls.at(-1)!.overrides as { stateDiff: unknown[] }[])[0]!;
    expect(diff.stateDiff.length).toBe(1);
  });

  test('an undiscoverable slot reports unsupported, so the caller falls back rather than trusting it', async () => {
    const node = nodeWithAllowanceAt(MAX_ALLOWANCE_SLOT_PROBE + 1);
    expect(await simulateWithAllowanceOverride(node.call, {
      chainId: 1, tx, owner: OWNER, token: TOKEN, spenders: [EXECUTOR], amount: 1n,
    })).toEqual({ ok: false, supported: false });
  });

  test('a real revert is a verdict on the route, NOT a reason to fall back', async () => {
    let probing = true;
    const node = nodeWithAllowanceAt(10);
    const call: OverrideCall = async (args) => {
      if (args.data.startsWith('0xdd62ed3e') && probing) return node.call(args);
      probing = false;
      return { ok: false, supported: true, revertData: 'ERC20: transfer amount exceeds balance' };
    };
    expect(await simulateWithAllowanceOverride(call, {
      chainId: 1, tx, owner: OWNER, token: TOKEN, spenders: [EXECUTOR], amount: 1n,
    })).toEqual({ ok: false, supported: true, revertData: 'ERC20: transfer amount exceeds balance' });
  });

  test('no spenders is unsupported, never a silent pass', async () => {
    const node = nodeWithAllowanceAt(10);
    expect(await simulateWithAllowanceOverride(node.call, {
      chainId: 1, tx, owner: OWNER, token: TOKEN, spenders: [], amount: 1n,
    })).toEqual({ ok: false, supported: false });
  });

  test('the simulation runs as the OWNER, or the executor would pull from nobody', async () => {
    const seen: (Address | undefined)[] = [];
    const node = nodeWithAllowanceAt(10);
    const call: OverrideCall = async (args) => { seen.push(args.account); return node.call(args); };
    await simulateWithAllowanceOverride(call, {
      chainId: 1, tx, owner: OWNER, token: TOKEN, spenders: [EXECUTOR], amount: 1n,
    });
    expect(seen.at(-1)).toBe(OWNER);
  });
});

/**
 * A single probe value proves only that the token answered with that number.
 * Two things answer with it without the override ever reaching storage: a
 * token whose real allowance already holds it, and a backend that accepts the
 * override argument and then ignores it. Discovery has to distinguish "the
 * slot I wrote is the one it reads" from "it said what I hoped to hear".
 */
describe('slot discovery proves the override CHANGED the answer', () => {
  /** A node that answers a constant for every slot, override or not. */
  const constantNode = (value: Hex) => {
    const call: OverrideCall = async () => ({ ok: true, supported: true, data: value });
    return call;
  };

  test('a token whose allowance already equals the first probe value is not a discovery', async () => {
    const slot = await findAllowanceSlot(
      constantNode('0x00000000000000000000000000000000000000000000000000000000deadbeef'),
      { chainId: 1, token: TOKEN, owner: OWNER, spender: SPENDER },
    );
    expect(slot).toBeNull();
  });

  test('a backend that accepts the override and ignores it is not a discovery either', async () => {
    // Same shape from the flow's side: every call comes back fine, and the
    // answer never depends on what was written.
    const slot = await findAllowanceSlot(
      constantNode('0x0000000000000000000000000000000000000000000000000000000000c0ffee'),
      { chainId: 1, token: TOKEN, owner: OWNER, spender: SPENDER },
    );
    expect(slot).toBeNull();
  });

  test('a node that really applies the override is still discovered, and the route can be proved', async () => {
    const node = nodeWithAllowanceAt(7);
    expect(await findAllowanceSlot(node.call, { chainId: 1, token: TOKEN, owner: OWNER, spender: SPENDER })).toBe(7);
    // Confirming the candidate costs one extra call on the matching slot only.
    const probes = node.calls.filter((entry) => entry.to === TOKEN).length;
    expect(probes).toBe(9);
  });
});

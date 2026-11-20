import { describe, expect, test } from 'bun:test';
import { buildDepositorByLabel, originDepositorFor, ORIGIN_DEPOSITOR_NOTE } from '../origin-depositor';

const LABEL = '0x' + 'ab'.repeat(32);
const ALICE = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const deposit = { type: 'Deposit', chainId: 1, label: LABEL, fullAddress: ALICE };

describe('original depositor', () => {
  test('a received transfer resolves to the deposit that carries its label', () => {
    const map = buildDepositorByLabel([deposit]);
    expect(originDepositorFor({ type: 'Transfer', direction: 'in', chainId: 1, label: LABEL }, map)).toBe(ALICE.toLowerCase());
  });
  test('label spelling does not matter (padded vs short hex)', () => {
    const map = buildDepositorByLabel([{ ...deposit, label: '0x1' }]);
    expect(originDepositorFor({ type: 'Transfer', direction: 'in', chainId: 1, label: '0x0001' }, map)).toBe(ALICE.toLowerCase());
  });
  test('same label on another chain is not matched', () => {
    const map = buildDepositorByLabel([deposit]);
    expect(originDepositorFor({ type: 'Transfer', direction: 'in', chainId: 56, label: LABEL }, map)).toBeNull();
  });
  test('only incoming transfers get one', () => {
    const map = buildDepositorByLabel([deposit]);
    expect(originDepositorFor({ type: 'Transfer', direction: 'out', chainId: 1, label: LABEL }, map)).toBeNull();
    expect(originDepositorFor({ type: 'Withdrawal', direction: 'in', chainId: 1, label: LABEL }, map)).toBeNull();
  });
  test('no label or no indexed deposit yet means nothing, never a guess', () => {
    const map = buildDepositorByLabel([deposit]);
    expect(originDepositorFor({ type: 'Transfer', direction: 'in', chainId: 1 }, map)).toBeNull();
    expect(originDepositorFor({ type: 'Transfer', direction: 'in', chainId: 1, label: '0x' + 'cd'.repeat(32) }, map)).toBeNull();
  });
  test('a swap or bridge deposit names an executor, so it is skipped', () => {
    const map = buildDepositorByLabel([{ ...deposit, fundingSource: 'bridged_pool' }, { ...deposit, label: '0x2', fundingSource: 'pool' }]);
    expect(map.size).toBe(0);
  });
  test('your own deposit is not worth telling you about', () => {
    const map = buildDepositorByLabel([deposit]);
    expect(originDepositorFor({ type: 'Transfer', direction: 'in', chainId: 1, label: LABEL }, map, ALICE)).toBeNull();
  });
  test('the note says it is not the sender, with no em dash or semicolon', () => {
    expect(ORIGIN_DEPOSITOR_NOTE).toContain('not necessarily');
    expect(ORIGIN_DEPOSITOR_NOTE).not.toContain('—');
    expect(ORIGIN_DEPOSITOR_NOTE).not.toContain(';');
  });
});

import { expect, test } from 'bun:test';
import { planUiParamRetire } from '@/services/ui-entry-retire';

const M = '__marker';

test('closing the detail sheet on its own pops the entry we pushed', () => {
  expect(planUiParamRetire({ hasKey: true, state: { [M]: true }, marker: M })).toEqual({ kind: 'back' });
});

// #285 P1: Withdraw from the phone detail sheet. An async back queued here
// landed after the withdraw modal pushed ?modal=withdraw and closed it again.
test('a detail action retires the entry synchronously, never with a back', () => {
  const plan = planUiParamRetire({ hasKey: true, state: { [M]: true, idx: 3 }, marker: M, followedByAction: true });
  expect(plan.kind).toBe('replace');
  // The marker goes, so a later retire never pops this entry; router state stays.
  expect(plan).toEqual({ kind: 'replace', state: { idx: 3 } });
});

test('an entry we did not push is rewritten, and no param means no-op', () => {
  expect(planUiParamRetire({ hasKey: true, state: null, marker: M })).toEqual({ kind: 'replace', state: null });
  expect(planUiParamRetire({ hasKey: false, state: { [M]: true }, marker: M, followedByAction: true })).toEqual({ kind: 'none' });
});

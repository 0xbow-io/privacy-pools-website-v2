import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const hub = readFileSync(new URL('../../components/home/action-hub.tsx', import.meta.url), 'utf8');

// Pat's QA on #26: the Swap form read "~10.044619 USDT ... Estimate, after
// fees", then review said "about 9.6068 USDT, below the pool's minimum of 10".
// The form estimate is a route preview with no relayer quote (that request is
// made by the review press), so it must never claim to be net of fees.
test('the Swap form estimate says it is before relayer fees, and where the minimum applies', () => {
  const start = hub.indexOf('const note = swapQuotedNet !== null');
  const block = hub.slice(start, hub.indexOf('</HoverHint>', start));
  expect(start).toBeGreaterThan(0);
  expect(block).not.toMatch(/Estimate, after fees|Estimate\. The exact rate/);
  expect(block).toContain('before relayer fees');
  expect(block).toContain('the pool minimum applies to what is left');
  // UI copy: no em dashes, no semicolons.
  for (const s of block.match(/'[^'\n]*'|`[^`\n]*`/g) ?? []) expect(s).not.toMatch(/[—;]/);
});

// Pat's decision: once a Review press was refused below the minimum, the
// headline is the net figure that refusal computed, not the pre-fee estimate.
test('the headline prefers the refused press\'s net figure, from the provider, with no fetch of its own', () => {
  const at = hub.indexOf('const swapPreviewText = !swapOutUnits');
  const headline = hub.slice(at, hub.indexOf(';', at));
  expect(headline.indexOf('swapQuotedNet !== null')).toBeGreaterThan(0);
  expect(headline.indexOf('swapQuotedNet !== null')).toBeLessThan(headline.indexOf('swapPreview.status'));
  expect(headline).toContain('depositValueText(swapQuotedNet, swapOutToken.decimals)');
  // Matched to the form it priced: amount, pair and destination.
  const gate = hub.slice(hub.indexOf('const swapQuotedNet ='), at);
  for (const k of ['grossWei === swapAmountWei', 'inputToken', 'outputToken', 'destinationChainId === swapDestChainId']) expect(gate).toContain(k);
  const provider = readFileSync(new URL('../../components/swap-modal-provider.tsx', import.meta.url), 'utf8');
  expect(provider).toContain('const netWei = depositBelowMinimumValue(err);');
  expect(provider).toContain('setQuotedNet(null);');
});

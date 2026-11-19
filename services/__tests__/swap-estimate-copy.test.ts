import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const hub = readFileSync(new URL('../../components/home/action-hub.tsx', import.meta.url), 'utf8');

// The preview is a locally sized note; the Review result replaces it without
// another SDK request or a raw share count under an underlying token label.
test('the Swap estimate describes the shielded note after estimated fees', () => {
  expect(hub).not.toContain('before relayer fees');
  expect(hub).toContain('Estimated shielded note');
  expect(hub).toContain('After estimated fees. Review refreshes the amount.');
});

test('the widget prefers the matching Review result to local note sizing', () => {
  expect(hub).toContain('const swapNoteWei = swapQuotedNet ?? swapLocalNote;');
  expect(hub).toContain('quotedNetFigure(swapNoteWei, swapOutToken, swapOutputRate)');
  const gate = hub.slice(hub.indexOf('const swapQuotedNet ='), hub.indexOf('const swapOutputIsShare'));
  for (const k of ['sourceChainId === chainId', 'grossWei === swapAmountWei', 'inputToken', 'outputToken', 'destinationChainId === swapDestChainId']) expect(gate).toContain(k);
  const provider = readFileSync(new URL('../../components/swap-modal-provider.tsx', import.meta.url), 'utf8');
  expect(provider).toContain('wei: display.newNoteValueWei');
  expect(provider).toContain('const netWei = depositBelowMinimumValue(err);');
  expect(provider).toContain('setQuotedNet(null);');
  expect(provider).toContain('New shielded note (estimated)');
  expect(provider).toContain('Dust to relayer');
  expect(provider).toContain('Dust to fallback address');
});

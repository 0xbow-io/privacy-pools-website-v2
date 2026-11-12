import { expect, test } from 'bun:test';
import { canReviewConsolidationAgain } from '../consolidation-confirm';

const refusal = 'Transfer failed: The relayer fee increased. Review the updated quote before trying again. Nothing was sent.';
test('consolidation re-review requires the complete no-broadcast fee verdict', () => {
  expect(canReviewConsolidationAgain(refusal)).toBe(true);
  const unavailable = 'Could not reach the relayer to price this transfer, so nothing was sent and your balance is unchanged. Try again in a moment. (Relayer quote failed to fetch: Failed to fetch)';
  expect(canReviewConsolidationAgain(unavailable)).toBe(true);
  expect(canReviewConsolidationAgain(`${unavailable} Consolidation outcome unknown`)).toBe(false);
  expect(canReviewConsolidationAgain('Relayer quote failed to fetch: Failed to fetch')).toBe(false);
  expect(canReviewConsolidationAgain(refusal.replaceAll(' ', '\n'))).toBe(true);
  for (const text of ['Transfer failed', 'The relayer fee increased.', 'Nothing was sent.',
    `${refusal} Consolidation outcome unknown`, `${refusal} transaction reverted`,
    `${refusal} Consolidation complete`, `${refusal} Notes consolidated`]) {
    expect(canReviewConsolidationAgain(text)).toBe(false);
  }
});

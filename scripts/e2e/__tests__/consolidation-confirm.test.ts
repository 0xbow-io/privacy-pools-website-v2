import { expect, test } from 'bun:test';
import { canReviewConsolidationAgain } from '../consolidation-confirm';

const refusal = 'Transfer failed: The relayer fee increased. Review the updated quote before trying again. Nothing was sent.';
test('consolidation re-review requires the complete no-broadcast fee verdict', () => {
  expect(canReviewConsolidationAgain(refusal)).toBe(true);
  expect(canReviewConsolidationAgain(refusal.replaceAll(' ', '\n'))).toBe(true);
  for (const text of ['Transfer failed', 'The relayer fee increased.', 'Nothing was sent.',
    `${refusal} Consolidation outcome unknown`, `${refusal} transaction reverted`,
    `${refusal} Consolidation complete`, `${refusal} Notes consolidated`]) {
    expect(canReviewConsolidationAgain(text)).toBe(false);
  }
});

import type { Page } from 'playwright';
import { waitForText } from './lib';

const quoteUnavailable = 'Could not reach the relayer to price this transfer, so nothing was sent and your balance is unchanged. Try again in a moment.';
const feeIncreased = 'The relayer fee increased. Review the updated quote before trying again. Nothing was sent.';

export function canReviewConsolidationAgain(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ');
  return (normalized.includes(feeIncreased) || normalized.includes(quoteUnavailable))
    && !/outcome unknown|Notes consolidated|Consolidation complete|transaction reverted/i.test(normalized);
}

/** Re-review the same selection only after the app establishes no broadcast. */
export async function confirmConsolidation(page: Page): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByTestId('consolidation-confirmation').waitFor();
    await page.getByTestId('consolidation-confirm').click();
    const terminal = await waitForText(page, /Notes consolidated|Consolidation complete|Transfer failed|Consolidation outcome unknown|must be worth more|would not submit|Could not reach the relayer to price this transfer/i, 900_000);
    if (!terminal || !canReviewConsolidationAgain(terminal) || attempt === 2) return terminal ?? '';
    console.log('  consolidation: reviewing again after explicit no-broadcast quote refusal');
    if (terminal.includes(quoteUnavailable)) await new Promise(resolve => setTimeout(resolve, 2000));
    // Back refreshes local selection and clears the old refusal. Review again
    // so the following terminal poll cannot match the previous error panel.
    await page.locator('[data-testid="consolidation-confirmation"] :is(button,[role="button"]):has-text("Back")').click();
    await page.getByTestId('consolidation-select').waitFor();
    await page.getByTestId('consolidation-review').click();
  }
  throw new Error('Unreachable consolidation attempt');
}

import type { Page } from 'playwright';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const unlockHeading = (page: Page) => page.getByText(/^(Unlock with passkey|Unlock your account)$/).filter({ visible: true }).last();

/** Handle a gate that arrives after signIn(), during any Playwright action. */
export async function installUnlockGateHandler(page: Page): Promise<void> {
  await page.addLocatorHandler(unlockHeading(page), () => unlockIfPrompted(page));
}

/** Read-only polling does not trigger Playwright locator handlers. */
export async function waitForUnlockedLink(page: Page, marker: string, timeoutMs = 90_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await unlockIfPrompted(page);
    const link = await page.evaluate((m) => {
      const fields = Array.from(document.querySelectorAll('input,textarea')) as (HTMLInputElement | HTMLTextAreaElement)[];
      const field = fields.map(el => el.value).find(value => value.includes(m));
      if (field) return field;
      const anchor = Array.from(document.querySelectorAll('a')).map(el => el.href).find(value => value.includes(m));
      if (anchor) return anchor;
      return (document.body.innerText || '').split(/\s+/).find(value => /^https?:\/\//.test(value) && value.includes(m)) ?? null;
    }, marker);
    if (link) return link;
    await sleep(250);
  }
  return null;
}

/**
 * Clear the keystore-unlock gate if it is on screen, via a real wallet signature
 * (a headless browser has no passkey).
 *
 * This cannot be done once at sign-in: the gate is raised by the first ACTION,
 * so a flow's CTA click gets answered by "Unlock with passkey" instead of by the
 * transaction. Returns whether a gate was present.
 */
export async function unlockIfPrompted(page: Page, maxWaitMs = 120_000): Promise<boolean> {
  const heading = unlockHeading(page);
  if (!(await heading.isVisible())) return false;
  console.log('  unlock gate: taking the wallet-signature path');
  const walletPath = page.getByText('Use wallet signature instead', { exact: false }).first();
  if (await walletPath.isVisible().catch(() => false)) {
    // A manual unlock call must not recursively invoke our locator handler.
    await walletPath.evaluate((button: HTMLElement) => button.click());
    await sleep(1500);
  }
  // "Sign in" also exists in the header, so target the overlay's own copy.
  const clicked = await page.evaluate(() => {
    const overlays = Array.from(document.querySelectorAll('div')).filter((d) => {
      const s = getComputedStyle(d);
      return s.position === 'fixed' && /Unlock (with passkey|your account)/.test(d.textContent || '');
    });
    const host = overlays.pop() ?? document.body;
    for (const want of ['Sign in', 'Sign message', 'Continue']) {
      const cta = Array.from(host.querySelectorAll('*')).find(
        (el) => el.textContent?.trim() === want && el.children.length === 0,
      ) as HTMLElement | undefined;
      if (cta) { ((cta.closest('button,[role="button"]') as HTMLElement) ?? cta).click(); return want; }
    }
    return null;
  });
  if (!clicked) throw new Error('Account unlock has no actionable sign-in control');
  console.log('  unlock gate: clicked', clicked);
  const until = Date.now() + maxWaitMs;
  while (Date.now() < until) {
    await sleep(Math.min(2000, Math.max(0, until - Date.now())));
    if (!(await heading.isVisible())) { console.log('  unlock gate: cleared'); return true; }
  }
  console.log(`  unlock gate: STILL on screen after ${Math.round(maxWaitMs / 1000)}s`);
  throw new Error('Account unlock did not finish before the e2e deadline');
}


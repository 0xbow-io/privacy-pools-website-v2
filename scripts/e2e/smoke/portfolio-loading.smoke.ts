// @ts-nocheck - drives a real browser with real playwright types.
//
// Portfolio while its inputs are still on the way: a figure that is not known
// yet is a shimmer, never "$0.00", never "0 USDC" and never a spinner, and the
// real figures replace it once the inputs land.
//
// The inputs are held at the network: token prices, the share-rate reads
// (ERC-4626 convertToAssets), and the ASP's rate history and vault metrics.
// Holding them keeps the page in the state a slow RPC or ASP leaves it in, which
// on a fast machine otherwise lasts a few milliseconds.
//
// Prod world, read-only wallet (./harness.ts): nothing is ever sent. The wallet
// is new, so the real figures are zeros: what this proves is the loading state
// and that it ends, not a yield figure (that needs a funded yield position).
import { check, connect, finish, hold, isShareRateRead, launch, open, sleep, unlockWithWallet } from './harness.ts';

const ZERO_USD = /\$0\.00\b/;
const ZERO_COIN = /(^|\s)0(?:\.0+)?\s(USDC|USDT|ETH|BNB)\b/;
const isYieldInput = (url: string, body: string) =>
  /token-prices|rate-history|vault-metrics/.test(url) || isShareRateRead(url, body);

const s = await launch('portfolio-loading');
const { page } = s;
const inputs = await hold(page, isYieldInput);

try {
  await open(page, '/portfolio');
  check(await connect(page), 'the read-only wallet connects');
  await sleep(2000);
  const signIn = page.getByTestId('portfolio-sign-in').first();
  if (await signIn.isVisible().catch(() => false)) await signIn.click().catch(() => {});
  await sleep(1500);
  check(await unlockWithWallet(page), 'the account unlocks with a wallet signature');

  // While held: sample the page for 20 s.
  let shimmer = 0;
  let spinner = 0;
  const zeros: string[] = [];
  let header = '';
  for (let i = 0; i < 40; i++) {
    shimmer = Math.max(shimmer, await page.getByTestId('portfolio-figure-loading').count());
    spinner = Math.max(spinner, await page.locator('[role="progressbar"]').filter({ visible: true }).count());
    const text = await s.text();
    const at = text.indexOf('Track all your positions');
    const body = at >= 0 ? text.slice(at) : text;
    header = body.slice(0, 200).replace(/\s+/g, ' ');
    for (const re of [ZERO_USD, ZERO_COIN]) {
      const m = re.exec(body);
      if (m) zeros.push(body.slice(Math.max(0, m.index - 30), m.index + 20).replace(/\s+/g, ' '));
    }
    await sleep(500);
  }
  await s.shot('inputs-held');
  check(inputs.held() > 0, 'the yield and share inputs were held', `${inputs.held()} requests`);
  check(shimmer > 0, 'a figure that is not known yet is a shimmer', header);
  check(spinner === 0, 'no spinner while loading');
  check(zeros.length === 0, 'no "$0.00" or "0 USDC" while the inputs are held', [...new Set(zeros)].slice(0, 3).join(' | '));
  await s.guardStep('portfolio, inputs held');

  inputs.release();
  // Released: the shimmer gives way to real figures.
  let settled = false;
  for (let i = 0; i < 120 && !settled; i++) {
    await sleep(500);
    const text = await s.text();
    settled = (await page.getByTestId('portfolio-figure-loading').count()) === 0
      && /Net Value\s*\$[\d,.]+/.test(text) && /Pending\s*\$[\d,.]+/.test(text);
  }
  await s.shot('inputs-in');
  const text = await s.text();
  const at = text.indexOf('Track all your positions');
  check(settled, 'the real figures replace the shimmer once the inputs land', text.slice(at, at + 200).replace(/\s+/g, ' '));
  await s.guardStep('portfolio, inputs in');
  check(s.refusedSends.length === 0, 'nothing asked the wallet to send', s.refusedSends.join(', '));
} catch (e) {
  check(false, 'the smoke ran to the end', String(e).slice(0, 300));
}
await finish('portfolio loading', s.browser);

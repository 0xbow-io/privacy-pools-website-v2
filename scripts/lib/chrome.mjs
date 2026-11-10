// The ONE place scripts launch a Chromium-family browser.
//
// - Google Chrome stable (`channel: 'chrome'`), never Playwright's bundled
//   Chromium, and no fallback to it when Chrome is missing: fail instead.
// - Sandbox always on: `chromiumSandbox: true`, and --no-sandbox /
//   --disable-setuid-sandbox are stripped from args. If the sandbox cannot
//   start (containers, Ubuntu 24.04 userns limits), fix the environment; do not
//   turn it off here.
// - Version guard: the launched browser must be >= MIN_CHROME_VERSION, checked
//   on the real browser that was launched, so it also covers the override below.
//
// Override: PW_EXECUTABLE_PATH (or the older PW_EXECUTABLE) points at a
// specific Chrome binary. It gets the same sandbox and the same version guard,
// so an old or bundled Chromium is refused just the same.
//
// Install Chrome for Playwright with: bunx playwright install --with-deps chrome
import { chromium } from 'playwright';
import { assertPatchedChrome } from './chrome-version.mjs';

export { MIN_CHROME_VERSION } from './chrome-version.mjs';

const SANDBOX_OFF_ARGS = new Set(['--no-sandbox', '--disable-setuid-sandbox']);

function chromeOptions(options = {}) {
  const { args = [], executablePath: _ignored, chromiumSandbox: _alsoIgnored, ...rest } = options;
  const override = process.env.PW_EXECUTABLE_PATH || process.env.PW_EXECUTABLE;
  return {
    ...rest,
    ...(override ? { executablePath: override } : { channel: 'chrome' }),
    chromiumSandbox: true,
    args: args.filter((arg) => !SANDBOX_OFF_ARGS.has(arg.split('=')[0])),
  };
}

/** chromium.launch() on patched Google Chrome with the sandbox on. */
export async function launchChrome(options = {}) {
  const browser = await chromium.launch(chromeOptions(options));
  try {
    assertPatchedChrome(browser.version());
  } catch (error) {
    await browser.close();
    throw error;
  }
  return browser;
}

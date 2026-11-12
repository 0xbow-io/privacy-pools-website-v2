// Pure Chrome version check, kept apart from chrome.mjs so it is testable
// without a browser.
//
// Chrome 156.0.8078.73 fixed CVE-2026-118306, -118331, -118344 and -118348.
// Playwright 1.64.1 still bundles Chromium 156.0.8078.4, so every script drives
// Google Chrome stable instead and refuses anything older than this.
export const MIN_CHROME_VERSION = '156.0.8078.73';

/** "156.0.8078.79" -> [156, 0, 8078, 79]. Throws on anything else. */
export function parseChromeVersion(version) {
  const parts = String(version).trim().split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`Unrecognised Chrome version "${version}"`);
  }
  return parts.map(Number);
}

/** True when `version` is strictly older than `min` (both dotted strings). */
export function isChromeOlderThan(version, min = MIN_CHROME_VERSION) {
  const v = parseChromeVersion(version);
  const m = parseChromeVersion(min);
  for (let i = 0; i < m.length; i++) {
    if (v[i] !== m[i]) return v[i] < m[i];
  }
  return false;
}

export function assertPatchedChrome(version, min = MIN_CHROME_VERSION) {
  if (isChromeOlderThan(version, min)) {
    throw new Error(`Chrome ${version} is older than ${min} and has known critical CVEs; update Google Chrome`);
  }
}

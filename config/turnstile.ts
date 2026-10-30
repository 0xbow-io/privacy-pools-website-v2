// Cloudflare Turnstile, loaded from OUR origin (Pat, 2026-10-30).
//
// A third-party <script> runs with full access to the page: if the host is
// compromised, so is every visitor's session. So the loader is vendored under
// public/vendor and served from our own domain, pinned by hash (the unit test
// recomputes it). The widget it opens is still Cloudflare's iframe on
// challenges.cloudflare.com, which stays cross-origin and cannot read this page.
//
// Cloudflare documents api.js as "load from our URL, do not self-host". The
// vendored copy is the versioned, immutable build below, so it only changes when
// we change it. If Turnstile starts failing, refresh it:
//   curl -sL https://challenges.cloudflare.com/turnstile/v0/api.js -o public/vendor/turnstile-api.js
//   sha256sum public/vendor/turnstile-api.js   -> TURNSTILE_VENDORED_SHA256 (below)
// and bump TURNSTILE_VENDORED_BUILD. Review the diff before shipping: it is code
// that runs on every page that opens the newsletter modal.

/** The api.js build vendored in public/vendor/turnstile-api.js (the id Cloudflare redirects /v0/api.js to). */
export const TURNSTILE_VENDORED_BUILD = 'c787ce48cf6b';

/** sha256 of public/vendor/turnstile-api.js; services/__tests__/turnstile-vendored.test.ts recomputes it. */
export const TURNSTILE_VENDORED_SHA256 = 'c455b9891f0f0552f07420cffeb6d6b0edb240b9cf81c050b633ecc781b54b7f';

/** Same-origin script path, without the query. */
export const TURNSTILE_SCRIPT_PATH = '/vendor/turnstile-api.js';

/** The src the app loads. `render=explicit` is read by the script from its own URL. */
export const TURNSTILE_SCRIPT_SRC = `${TURNSTILE_SCRIPT_PATH}?render=explicit`;

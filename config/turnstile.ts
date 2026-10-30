// Cloudflare Turnstile, pinned by hash (Pat, 2026-10-30).
//
// A third-party <script> runs with full access to the page: if its host is
// compromised, so is every visitor's session. Self-hosting api.js does not work:
// the script refuses to run unless its own tag points at challenges.cloudflare.com
// (it throws "Could not find Turnstile valid script tag" otherwise, which broke
// the first attempt in #50). So we pin the BYTES instead: the versioned,
// immutable build URL plus a Subresource Integrity hash. The browser refuses to
// run anything else, whatever Cloudflare's servers return, and the build id in
// the URL means Cloudflare cannot swap the file under us.
//
// The widget it opens is still Cloudflare's own iframe on challenges.cloudflare.com,
// cross-origin, so it cannot read this page.
//
// To update (only if Turnstile stops working or we choose to upgrade):
//   curl -sL https://challenges.cloudflare.com/turnstile/v0/api.js -D - -o /dev/null | grep -i location
//   -> /turnstile/v0/g/<build>/api.js ; set TURNSTILE_BUILD to <build>
//   curl -s https://challenges.cloudflare.com/turnstile/v0/g/<build>/api.js | openssl dgst -sha256 -binary | openssl base64 -A
//   -> TURNSTILE_INTEGRITY = 'sha256-<that>'
// Review the new file before shipping: it is code that runs on our origin.

/** The api.js build we pin (the id Cloudflare redirects /v0/api.js to). */
export const TURNSTILE_BUILD = 'c787ce48cf6b';

/** Subresource Integrity of that build; the browser blocks the script if the bytes differ. */
export const TURNSTILE_INTEGRITY = 'sha256-xFW5iR8PBVLwdCDP/rbWsO2yQLnPgcBQtjPsx4G1S38=';

/** The versioned URL, without the query. It matches the host and path the script itself requires. */
export const TURNSTILE_SCRIPT_URL = `https://challenges.cloudflare.com/turnstile/v0/g/${TURNSTILE_BUILD}/api.js`;

/** The src the app loads. `render=explicit` is read by the script from its own URL. */
export const TURNSTILE_SCRIPT_SRC = `${TURNSTILE_SCRIPT_URL}?render=explicit`;

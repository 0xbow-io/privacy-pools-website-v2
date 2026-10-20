import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASSKEY_RELATED_ORIGIN_HOSTS } from '../../services/passkey-rp-id';

// Once this app serves the apex, it also serves the WebAuthn related-origins
// file. It must list exactly the hosts the RP-ID helper trusts.
describe('public/.well-known/webauthn', () => {
  test('lists the related-origin hosts the passkey RP ID trusts', () => {
    const file = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', '.well-known', 'webauthn'), 'utf8'));
    const hosts = (file.origins as string[]).map((o) => new URL(o).hostname).sort();
    expect(hosts).toEqual([...PASSKEY_RELATED_ORIGIN_HOSTS].sort());
  });
});

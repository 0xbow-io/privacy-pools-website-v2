import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

// DEV-456: the self-funded claim sent both registration transactions and only
// then found the relayer fee exceeded the payment. The affordability quote must
// run before the wallet is asked to pay for anything.
describe('self-funded claim checks the fee before registering', () => {
  test('the preflight quote precedes the first registration send', () => {
    const source = readFileSync(join(ROOT, 'hooks/use-note-import.ts'), 'utf8');
    // The claim's registration, not DEV-493's register-only offer (which
    // claims nothing and so has no fee to check): the anchor is the one whose
    // registration is followed by the preflight.
    const claimStart = source.indexOf('const importOnChain = useCallback(');
    expect(claimStart).toBeGreaterThan(-1);
    const registerStart = source.indexOf('session.prepareRegisterKeystore()', claimStart);
    expect(registerStart).toBeGreaterThan(-1);
    // Both legs are sent by sendRegistrationLegs since DEV-493.
    const firstSend = source.indexOf('await sendRegistrationLegs(registration)', registerStart);
    expect(firstSend).toBeGreaterThan(registerStart);
    expect(source.slice(registerStart, firstSend)).not.toContain('sendTransactionAsync(');
    const preflight = source.slice(registerStart, firstSend);
    // The transfer route the anchor pays, not the withdrawal quote: that one
    // names the wallet as recipient and prices a different transaction.
    expect(preflight).toContain('probeTransferFee(');
    expect(preflight).not.toContain('getQuote(');
    // The refusal itself, not only the fetch: a rejection or a fee at or above
    // the note must THROW before the first send.
    const cond = preflight.indexOf("fee === 'rejected' || (fee !== null && fee >= value)");
    expect(cond).toBeGreaterThan(-1);
    // Inside the fee condition's own body (its closing brace is the first one
    // at the condition's indentation), not merely somewhere before the send.
    const rest = preflight.slice(cond);
    const lineStart = preflight.lastIndexOf('\n', cond) + 1;
    const indent = preflight.slice(lineStart, cond).match(/^\s*/)?.[0] ?? '';
    const body = rest.slice(0, rest.indexOf(`\n${indent}}`));
    expect(body).toMatch(/throw new Error\(/);
  });
});

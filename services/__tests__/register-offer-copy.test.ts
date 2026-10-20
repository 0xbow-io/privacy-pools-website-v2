import { describe, expect, test } from 'bun:test';

import { REGISTER_OFFER_DONE, REGISTER_OFFER_TITLE, registerOfferBody } from '../register-offer-copy';

describe('register instead of a too-small claim (DEV-493)', () => {
  test('says registering does not claim this payment, and that it stays saved', () => {
    const body = registerOfferBody('0.0012 ETH');
    expect(body).toContain('about 0.0012 ETH in gas');
    expect(body).toContain('does not claim this payment');
    expect(body).toContain('stays saved on this device');
  });

  test('no gas figure, no invented one', () => {
    expect(registerOfferBody(null)).not.toContain('in gas');
  });

  test('no em dashes', () => {
    for (const line of [REGISTER_OFFER_TITLE, registerOfferBody('1 ETH'), REGISTER_OFFER_DONE]) {
      expect(line).not.toContain('—');
    }
  });
});

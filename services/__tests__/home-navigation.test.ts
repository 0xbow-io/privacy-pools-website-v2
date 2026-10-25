import { beforeEach, describe, expect, test } from 'bun:test';
import { clearHomePanel, getHomeDestination, phonePanelTarget, redirectPhonePanel, rememberHomeLocation } from '../home-navigation';

beforeEach(() => rememberHomeLocation({ pathname: '/', search: '' }));

describe('home navigation memory', () => {
  test('remembers balances, activity, and an explicitly closed panel', () => {
    for (const search of ['?action=request&panel=balances', '?action=send&panel=activity', '?action=shield']) {
      rememberHomeLocation({ pathname: '/', search });
      rememberHomeLocation({ pathname: '/explore', search: '' });
      expect(getHomeDestination()).toBe(`/${search}`);
    }
  });

  test('never restores signing, wallet picker, or detail overlays', () => {
    rememberHomeLocation({ pathname: '/', search: '?panel=activity&action=shield&modal=seed&connect=1&tx=123&notifications=1' });
    expect(getHomeDestination()).toBe('/?action=shield&panel=activity');
  });

  test('sign-out clears the account panel while keeping the selected action', () => {
    rememberHomeLocation({ pathname: '/', search: '?action=request&panel=balances' });
    clearHomePanel();
    expect(getHomeDestination()).toBe('/?action=request');
  });
});

describe('phone panel redirect', () => {
  const evm = { nonEvm: false, signedIn: true };

  test('a redirected panel is never the Shield destination', () => {
    rememberHomeLocation({ pathname: '/', search: '?action=send&panel=balances' });
    expect(redirectPhonePanel('balances', evm)).toBe('/portfolio');
    expect(getHomeDestination()).toBe('/?action=send');
    // Shield after the redirect lands home, so the redirect cannot fire again.
    expect(redirectPhonePanel(null, evm)).toBeNull();
  });

  test('keeps the legacy surface where Portfolio cannot serve it', () => {
    rememberHomeLocation({ pathname: '/', search: '?panel=activity' });
    expect(redirectPhonePanel('activity', { nonEvm: false, signedIn: false })).toBeNull();
    expect(redirectPhonePanel('balances', { nonEvm: true, signedIn: true })).toBeNull();
    expect(getHomeDestination()).toBe('/?panel=activity');
  });

  test('signed-out balances still go to Portfolio (its sign-in card)', () => {
    expect(phonePanelTarget('balances', { nonEvm: false, signedIn: false })).toBe('/portfolio');
  });
});

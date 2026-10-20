import { beforeEach, describe, expect, test } from 'bun:test';
import { clearHomePanel, getHomeDestination, rememberHomeLocation } from '../home-navigation';

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

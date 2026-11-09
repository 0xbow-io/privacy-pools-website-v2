import { describe, expect, test } from 'bun:test';
import { buildMode } from '../../scripts/build-mode.mjs';

describe('web build mode', () => {
  test('previews and development deployments take the fast build', () => {
    expect(buildMode({ VERCEL_ENV: 'preview' })).toBe('fast');
    expect(buildMode({ VERCEL_ENV: 'development' })).toBe('fast');
  });
  test('production, local and CI builds stay on the full optimization', () => {
    expect(buildMode({ VERCEL_ENV: 'production' })).toBe('full');
    expect(buildMode({})).toBe('full');
    expect(buildMode({ VERCEL_ENV: '' })).toBe('full');
    expect(buildMode({ VERCEL_ENV: 'something-new' })).toBe('full');
  });
  test('WEB_BUILD_MODE forces a mode, anything else about it is ignored', () => {
    expect(buildMode({ VERCEL_ENV: 'preview', WEB_BUILD_MODE: 'full' })).toBe('full');
    expect(buildMode({ VERCEL_ENV: 'production', WEB_BUILD_MODE: 'fast' })).toBe('fast');
    expect(buildMode({ VERCEL_ENV: 'preview', WEB_BUILD_MODE: 'turbo' })).toBe('fast');
    expect(buildMode({ VERCEL_ENV: 'production', WEB_BUILD_MODE: '' })).toBe('full');
  });
});

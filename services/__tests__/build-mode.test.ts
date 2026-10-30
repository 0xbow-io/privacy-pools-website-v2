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
});

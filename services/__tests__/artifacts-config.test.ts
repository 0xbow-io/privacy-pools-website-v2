import { afterEach, describe, expect, test } from 'bun:test';
import { artifactsBase, artifactsBaseUrl, resolveArtifactsOrigin } from '../../config/artifacts';
import artifactsOrigin from '../../config/artifacts-origin.json';
import {
  isStaleAssetResponse,
  reportStaleAssets,
  resetStaleAssetsForTest,
  staleAssetsReported,
  STALE_ASSETS_ERROR,
  subscribeStaleAssets,
} from '../stale-assets';

describe('artifacts origin and base', () => {
  test('the origin is the env value without trailing slashes, else the default', () => {
    expect(resolveArtifactsOrigin('https://artifacts.privacypools.com/')).toBe('https://artifacts.privacypools.com');
    expect(resolveArtifactsOrigin(undefined)).toBe(artifactsOrigin.default);
    expect(resolveArtifactsOrigin('')).toBe(artifactsOrigin.default);
    // Not https: never load proving keys over a plain or relative origin.
    expect(resolveArtifactsOrigin('http://artifacts.example.com')).toBe(artifactsOrigin.default);
    expect(resolveArtifactsOrigin('//artifacts.example.com')).toBe(artifactsOrigin.default);
  });

  test('a versioned build reads the artifacts origin, a local build the flat /artifacts', () => {
    expect(artifactsBase('0b62f6b7e5eb', 'https://artifacts.example.com')).toBe('https://artifacts.example.com/artifacts/0b62f6b7e5eb');
    expect(artifactsBase('', 'https://artifacts.example.com')).toBe('/artifacts');
  });

  test('a relative base is resolved against the page, an absolute one is left alone', () => {
    expect(artifactsBaseUrl('/artifacts', 'https://app.example.com')).toBe('https://app.example.com/artifacts');
    expect(artifactsBaseUrl('/artifacts', undefined)).toBe('/artifacts');
    expect(artifactsBaseUrl('https://artifacts.example.com/artifacts/v1', 'https://app.example.com')).toBe('https://artifacts.example.com/artifacts/v1');
  });

  test('the default origin is https', () => {
    expect(artifactsOrigin.default.startsWith('https://')).toBe(true);
  });
});

describe('stale assets', () => {
  afterEach(() => resetStaleAssetsForTest());

  test('only a 404 on a versioned build means the tab is out of date', () => {
    expect(isStaleAssetResponse({ versioned: true, status: 404 })).toBe(true);
    // Locally a 404 is a missing file, not an old tab.
    expect(isStaleAssetResponse({ versioned: false, status: 404 })).toBe(false);
    // A server error or a rate limit is not a version problem.
    expect(isStaleAssetResponse({ versioned: true, status: 500 })).toBe(false);
    expect(isStaleAssetResponse({ versioned: true, status: 429 })).toBe(false);
  });

  test('the report reaches the listener once, however many files fail', () => {
    let calls = 0;
    subscribeStaleAssets(() => { calls += 1; });
    reportStaleAssets();
    reportStaleAssets();
    expect(calls).toBe(1);
    expect(staleAssetsReported()).toBe(true);
  });

  test('the error text asks for a reload and never shows a path', () => {
    expect(STALE_ASSETS_ERROR).toContain('Reload the page');
    expect(STALE_ASSETS_ERROR).not.toContain('/artifacts');
  });
});

import { describe, expect, test } from 'bun:test';
import { privateErrorReportEvent } from '../error-reports-event';
import { firstComponentName, firstFramePosition, parseComponentFrames } from '../crash-frame';

// The shapes a real stack has: Chrome's production web stack (React 19), where the
// first line is an anonymous function, which is exactly what V2-APP-5 looked like.
const CHROME_PROD = [
  '',
  '    at https://privacypools.com/_expo/static/js/web/index-870719235a419d3a5f5eb8b4628c5f99.js:1:234567',
  '    at Xt (https://privacypools.com/_expo/static/js/web/index-870719235a419d3a5f5eb8b4628c5f99.js:1:98765)',
  '    at SwapRow (https://privacypools.com/_expo/static/js/web/__common-ed39d916c1c383490d1f43aff958196f.js:2:11)',
].join('\n');

describe('component stack frames', () => {
  test('an anonymous first frame is skipped, never read as a component called https', () => {
    expect(firstComponentName(CHROME_PROD)).toBe('Xt');
    expect(firstComponentName(CHROME_PROD)).not.toBe('https');
  });

  test('the position is the first frame that has one, as a single identifier', () => {
    expect(firstFramePosition(CHROME_PROD)).toBe('at_index_870719235a419d3a5f5eb8b4628c5f99_js_1_234567');
    expect(firstFramePosition(CHROME_PROD)).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
  });

  test('the older shapes still read: dev "in Name", Safari and Firefox "Name@url", a bare name', () => {
    expect(firstComponentName('    in SwapModalProvider (at x.tsx:1)\n    in Foo')).toBe('SwapModalProvider');
    expect(firstComponentName('SwapRow@https://h/index-ab.js:3:4')).toBe('SwapRow');
    expect(firstComponentName('SwapModalProvider')).toBe('SwapModalProvider');
    expect(firstFramePosition('SwapRow@https://h/index-ab.js:3:4')).toBe('at_index_ab_js_3_4');
  });

  test('a query string, a path or a non-build file never becomes a position', () => {
    expect(firstFramePosition('    at Foo (https://h/a/b/c.js?token=0xabc:1:2)')).toBeUndefined();
    // The path is dropped: only the final segment is read.
    expect(firstFramePosition('    at Foo (https://h/a/b/index-ab.js:1:2)')).toBe('at_index_ab_js_1_2');
  });

  test('a Firefox anonymous frame still gives a position', () => {
    expect(firstFramePosition('@https://host/index-ab.js:1:2')).toBe('at_index_ab_js_1_2');
    expect(firstComponentName('@https://host/index-ab.js:1:2')).toBeUndefined();
  });

  test('a long build file name keeps the position under the limit, line and column whole', () => {
    const file = `index-${'a'.repeat(60)}.js`;
    const position = firstFramePosition(`    at Foo (https://h/${file}:123456:789)`);
    expect(position).toBeDefined();
    expect(position!.length).toBeLessThanOrEqual(64);
    expect(position!.endsWith('_123456_789')).toBe(true);
    expect(/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(position!)).toBe(true);
    const event = privateErrorReportEvent({ contexts: { errorReport: { message: 'client-failed', code: { componentPosition: position } } } }, {});
    expect(JSON.stringify(event)).toContain(position!);
  });

  test('nothing in, nothing out', () => {
    expect(parseComponentFrames(undefined)).toEqual([]);
    expect(firstComponentName(null)).toBeUndefined();
    expect(firstFramePosition('')).toBeUndefined();
  });
});

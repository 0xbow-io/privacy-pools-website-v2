import { describe, expect, test } from 'bun:test';
import { errorShape, isCodeName } from '../error-shape';
import { privateErrorReportEvent } from '../error-reports-event';

const CODE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

describe('the shape of a crash message', () => {
  test('the common JS and React sentences become one identifier', () => {
    expect(errorShape("Cannot read properties of undefined (reading 'decimals')")).toBe('read_undefined_decimals');
    expect(errorShape("Cannot read properties of null (reading 'symbol')")).toBe('read_null_symbol');
    expect(errorShape("Cannot set properties of undefined (setting 'current')")).toBe('set_undefined_current');
    expect(errorShape("Cannot destructure property 'address' of 'e' as it is undefined.")).toBe('destructure_undefined_address');
    expect(errorShape('swapOut.map is not a function')).toBe('notFunction_swapOut_map');
    expect(errorShape('tokens is not iterable')).toBe('notIterable_tokens');
    expect(errorShape('maxSupply is not defined')).toBe('notDefined_maxSupply');
    expect(errorShape('Maximum update depth exceeded. This can happen when a component calls setState inside useEffect')).toBe('maxUpdateDepth');
    expect(errorShape('Too many re-renders. React limits the number of renders')).toBe('tooManyRerenders');
    expect(errorShape('Rendered more hooks than during the previous render.')).toBe('hookCountChanged');
    expect(errorShape('Cannot convert 12.5 to a BigInt')).toBe('toBigInt');
  });

  test('a value used as a key never travels: addresses, symbols and share symbols', () => {
    expect(errorShape("Cannot read properties of undefined (reading '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409')")).toBeUndefined();
    expect(errorShape("Cannot read properties of undefined (reading 'FDUSD')")).toBeUndefined();
    expect(errorShape("Cannot read properties of undefined (reading 'ppUSDT')")).toBeUndefined();
    expect(errorShape("Cannot read properties of undefined (reading '4001.21')")).toBeUndefined();
    expect(errorShape("Cannot read properties of undefined (reading '12 USDC')")).toBeUndefined();
  });

  test('an unrecognised message is not reported, and a number or nothing is not either', () => {
    expect(errorShape('Withdrawal failed: 4000 USDC to 0x98AdDcc75931795eB66c52cA954541c18535E3c0')).toBeUndefined();
    expect(errorShape('The relayer quoted 1.21 USDC')).toBeUndefined();
    expect(errorShape(undefined)).toBeUndefined();
    expect(errorShape(11155111)).toBeUndefined();
  });

  test('a callee that is an expression, not a name, is dropped', () => {
    expect(errorShape('(intermediate value).foo is not a function')).toBeUndefined();
    expect(errorShape('tokens[0].decimals is not a function')).toBeUndefined();
  });

  test('whatever comes out passes the same identifier filter the constructor applies', () => {
    for (const message of [
      "Cannot read properties of undefined (reading 'decimals')",
      'a.b.c.d.e.f is not a function',
      'Maximum update depth exceeded',
    ]) {
      const shape = errorShape(message);
      expect(shape).toBeDefined();
      expect(shape!).toMatch(CODE_IDENTIFIER);
      expect(shape!.length).toBeLessThanOrEqual(64);
    }
  });

  test('code names: lowercase source text yes, symbols and values no', () => {
    expect(isCodeName('decimals')).toBe(true);
    expect(isCodeName('_inner')).toBe(true);
    for (const name of ['ETH', 'FDUSD', 'ppUSDC', '0xabc', '1', '', 'a'.repeat(33), 'Foo']) {
      expect({ name, ok: isCodeName(name) }).toEqual({ name, ok: false });
    }
  });
});

describe('both new keys reach the outgoing event in prod, and only as identifiers', () => {
  const code = (bag: Record<string, unknown>) =>
    privateErrorReportEvent({ contexts: { errorReport: { message: 'client-failed', code: bag } } }, {})?.contexts?.code;

  test('the shape and the position travel ungated', () => {
    expect(code({
      errorName: 'TypeError',
      componentFrame: 'Xt',
      errorShape: 'read_undefined_decimals',
      componentPosition: 'at_index_ab12_js_1_234567',
    })).toEqual({
      errorName: 'TypeError',
      componentFrame: 'Xt',
      errorShape: 'read_undefined_decimals',
      componentPosition: 'at_index_ab12_js_1_234567',
    });
  });

  test('a message or a url put in either key is refused', () => {
    expect(code({ errorShape: "Cannot read properties of undefined (reading 'decimals')" })).toBeUndefined();
    expect(code({ componentPosition: 'https://privacypools.com/index-ab12.js:1:2' })).toBeUndefined();
    expect(code({ componentPosition: 'index-ab12.js:1:2' })).toBeUndefined();
  });
});

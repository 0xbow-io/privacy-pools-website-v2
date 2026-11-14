import { expect, test } from 'bun:test';
import { coreFixtureKey } from '../core-fixture';

test('core fixture is recoverable and independent across run attempts and funders', () => {
  const funder = '0x' + '01'.repeat(32);
  const key = coreFixtureKey(funder, '123:1');
  expect(coreFixtureKey(funder, '123:1')).toBe(key);
  expect(coreFixtureKey(funder.slice(2), '123:1')).toBe(key);
  expect(coreFixtureKey(funder, '123:2')).not.toBe(key);
  expect(coreFixtureKey(funder, '124:1')).not.toBe(key);
  expect(coreFixtureKey('0x' + '02'.repeat(32), '123:1')).not.toBe(key);
  expect(key).not.toBe(funder);
  expect(() => coreFixtureKey(funder, '')).toThrow('run identity');
});

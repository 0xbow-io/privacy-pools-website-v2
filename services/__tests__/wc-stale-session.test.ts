import { describe, expect, test } from 'bun:test';
import { dropStaleWcSession } from '../wc-stale-session';

describe('dropStaleWcSession', () => {
  test('disconnects a lingering session', async () => {
    let n = 0;
    await dropStaleWcSession({ getProvider: async () => ({ session: {}, disconnect: async () => { n++; } }) });
    expect(n).toBe(1);
  });
  test('leaves a fresh provider alone', async () => {
    let n = 0;
    await dropStaleWcSession({ getProvider: async () => ({ disconnect: async () => { n++; } }) });
    expect(n).toBe(0);
  });
  test('never throws', async () => {
    await dropStaleWcSession({ getProvider: async () => { throw new Error('x'); } });
    await dropStaleWcSession({ getProvider: async () => ({ session: {}, disconnect: async () => { throw new Error('y'); } }) });
  });
});

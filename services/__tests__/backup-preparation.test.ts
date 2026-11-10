import { expect, test } from 'bun:test';
import { withBackupDeadline } from '../backup-preparation';

test('completed exports keep their exact result', async () => {
  const result = { serialized: 'private backup' };
  expect(await withBackupDeadline(Promise.resolve(result), 100)).toBe(result);
});

test('export failures remain errors rather than an empty backup', async () => {
  await expect(withBackupDeadline(Promise.reject(new Error('storage unavailable')), 100)).rejects.toThrow('storage unavailable');
});

test('a stalled export ends the wait without requiring completion', async () => {
  await expect(withBackupDeadline(new Promise(() => {}), 5)).rejects.toThrow('Keep your browser data');
});

test('late failures after a timeout are handled', async () => {
  let fail!: (error: Error) => void;
  const work = new Promise((_, reject) => { fail = reject; });
  await expect(withBackupDeadline(work, 5)).rejects.toThrow('Backup took too long');
  fail(new Error('late failure'));
  await Promise.resolve();
});

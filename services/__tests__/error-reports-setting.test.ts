import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { privateErrorReportEvent } from '../error-reports-event';
import {
  errorReportsMenuLabel,
  onErrorReportsEnabledChange,
  readErrorReportsEnabled,
  writeErrorReportsEnabled,
} from '../error-reports-setting';

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
}

const EVENT = { event_id: 'a'.repeat(32), contexts: { errorReport: { message: 'deposit-failed' } } };

describe('anonymous error reports switch', () => {
  test('on by default, off once switched off, on again', () => {
    const storage = memoryStorage();
    expect(readErrorReportsEnabled(storage)).toBe(true);
    writeErrorReportsEnabled(false, storage);
    expect(readErrorReportsEnabled(storage)).toBe(false);
    writeErrorReportsEnabled(true, storage);
    expect(readErrorReportsEnabled(storage)).toBe(true);
  });

  test('a storage that throws reads as on and writes without throwing', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readErrorReportsEnabled(broken)).toBe(true);
    expect(() => writeErrorReportsEnabled(false, broken)).not.toThrow();
  });

  test('listeners hear the change', () => {
    const heard: boolean[] = [];
    const stop = onErrorReportsEnabledChange((v) => heard.push(v));
    writeErrorReportsEnabled(false, memoryStorage());
    stop();
    writeErrorReportsEnabled(true, memoryStorage());
    expect(heard).toEqual([false]);
  });

  test('setting off: no event is built', () => {
    expect(privateErrorReportEvent(EVENT, { enabled: () => false })).toBeNull();
    expect(privateErrorReportEvent(EVENT, { enabled: () => { throw new Error('x'); } })).toBeNull();
    expect(privateErrorReportEvent(EVENT, { enabled: () => true })).not.toBeNull();
  });

  test('setting off: the reporter hands nothing to the client and does not start it', () => {
    const src = readFileSync(join(new URL('.', import.meta.url).pathname, '..', 'error-reports.ts'), 'utf8');
    const report = src.slice(src.indexOf('export function reportErrorReport('));
    expect(report.indexOf('if (!readErrorReportsEnabled()) return;')).toBeLessThan(report.indexOf('sendErrorReportEvent('));
    const init = src.slice(src.indexOf('export function initErrorReport('));
    expect(init.indexOf('if (!readErrorReportsEnabled())')).toBeLessThan(init.indexOf('initSentry('));
    expect(init).toContain('enabled: () => readErrorReportsEnabled()');
  });

  test('the menu label reflects the state', () => {
    expect(errorReportsMenuLabel(true)).toBe('Anonymous error reports: On');
    expect(errorReportsMenuLabel(false)).toBe('Anonymous error reports: Off');
  });
});

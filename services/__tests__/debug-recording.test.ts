import { describe, expect, test } from 'bun:test';

import { buildDebugRecording, debugRecordingFileName, jsonSafe, MAX_RECORDED_ENTRIES } from '../debug-recording';

describe('debug recording file', () => {
  test('context first, then every entry with its time since the start', () => {
    const out = JSON.parse(buildDebugRecording(
      [
        { timestamp: 1_000, level: 'info', tag: 'UI', message: 'press "Send"', data: { box: '1,2 3x4' } },
        { timestamp: 2_500, level: 'error', tag: 'Transfer', message: 'failed' },
      ],
      { startedAt: 500, stoppedAt: 3_000, environment: 'Production', url: 'https://v2.privacypools.com/' },
    ));
    expect(out.kind).toBe('ppv2-debug-recording');
    expect(out.durationMs).toBe(2_500);
    expect(out.entryCount).toBe(2);
    expect(out.truncated).toBe(false);
    expect(out.entries[0]).toEqual({ at: '1970-01-01T00:00:01.000Z', sinceStartMs: 500, level: 'info', tag: 'UI', message: 'press "Send"', data: { box: '1,2 3x4' } });
    expect(out.entries[1].data).toBeUndefined();
  });

  test('odd payloads never lose the recording', () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(jsonSafe({ n: 10n })).toEqual({ n: '10' });
    expect(jsonSafe(loop)).toEqual({ a: 1, self: '[circular]' });
    expect(jsonSafe(new Error('boom'))).toEqual({ name: 'Error', message: 'boom' });
  });

  test('a full recording says it was cut, and the file name sorts by time', () => {
    const entries = Array.from({ length: MAX_RECORDED_ENTRIES }, (_, i) => ({ timestamp: i, level: 'debug' as const, tag: 't', message: 'm' }));
    expect(JSON.parse(buildDebugRecording(entries, { startedAt: 0, stoppedAt: 1, environment: 'x' })).truncated).toBe(true);
    expect(debugRecordingFileName(0)).toBe('ppv2-recording-1970-01-01T00-00-00-000Z.json');
  });
});

const read = (rel: string) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', rel), 'utf8') as string;

describe('the record button', () => {

  test('sits in the header next to the Actions menu, not inside it, and only in debug mode', () => {
    const header = read('components/ui/header.tsx');
    const at = header.indexOf('<DebugRecordButton />');
    expect(at).toBeGreaterThan(-1);
    expect(header.indexOf('{/* Actions Dropdown */}')).toBeGreaterThan(at);
    const provider = read('components/debug-provider.tsx');
    expect(provider).toContain("if (!isDebugEnabled || Platform.OS !== 'web') return null;");
  });

  test('every logged entry goes into the running recording, capped', () => {
    const provider = read('components/debug-provider.tsx');
    expect(provider).toContain('recording.current?.log.push(entry);');
    expect(provider).toContain('session.current?.log.push(entry);');
  });
});

describe('state snapshots', () => {
  test('every registered snapshot is collected JSON-safe, a failing one records its error', async () => {
    const { registerDebugSnapshot, collectDebugSnapshots } = await import('../debug-snapshots');
    const offA = registerDebugSnapshot('a', () => ({ n: 5n }));
    const offB = registerDebugSnapshot('b', () => { throw new Error('locked'); });
    expect(collectDebugSnapshots()).toEqual({ a: { n: '5' }, b: { snapshotError: 'locked' } });
    offA();
    offB();
    expect(collectDebugSnapshots()).toEqual({});
  });

  test('a recording carries both snapshots and says it holds secrets', () => {
    const out = JSON.parse(buildDebugRecording([], { startedAt: 0, stoppedAt: 1, environment: 'x', snapshots: { atStart: { a: 1 }, atStop: { a: 2 } } }));
    expect(out.snapshots).toEqual({ atStart: { a: 1 }, atStop: { a: 2 } });
    expect(out.containsSecrets).toBe(true);
  });

  test('identity, pools and the activity table register, with keys and notes', () => {
    const sdk = read('components/sdk-provider.tsx');
    expect(sdk).toContain("registerDebugSnapshot('identity'");
    expect(sdk).toContain('viewingPrivateKey: viewing?.privateKey');
    expect(sdk).toContain('accountKey,');
    const pools = read('components/pools-provider.tsx');
    expect(pools).toContain("registerDebugSnapshot('pools'");
    expect(pools).toContain('storedAccountExportsByChain');
    expect(read('components/pools/transactions.tsx')).toContain('registerDebugSnapshot(`transactionsTable:');
    expect(read('components/debug-provider.tsx')).toContain('{RECORDING_SECRET_WARNING}');
  });
});

describe('export dialog and capture', () => {
  test('save and REC stop both open the dialog with the two choices', () => {
    const provider = read('components/debug-provider.tsx');
    expect(provider).toContain("const handleExport = () => openExport('session');");
    expect(provider).toContain("setExportOpen('recording');");
    expect(provider).toContain('testID="debug-export-session"');
    expect(provider).toContain('testID="debug-export-recording"');
  });

  test('capture runs while debug mode is on and the logger echo is not captured twice', () => {
    const provider = read('components/debug-provider.tsx');
    expect(provider).toContain('const uninstall = installDebugCapture(log);');
    expect(provider).toContain("uncaptured(() => fn(prefix, message, data !== undefined ? data : ''));");
  });
});

test('the warning is the owner\'s wording', async () => {
  const { RECORDING_SECRET_WARNING } = await import('../debug-recording');
  expect(RECORDING_SECRET_WARNING).toBe('Contains your account key and all your keys. Anyone with this file can spend your funds. Share it only with the team and with a test account with less than $100. Never use this account again for anything else than testing.');
});

describe('BoundedDebugLog', () => {
  test('drop-oldest keeps the latest entries within budget and says it cut', async () => {
    const { BoundedDebugLog } = await import('../debug-recording');
    const log = new BoundedDebugLog('drop-oldest', 3);
    for (let i = 0; i < 5; i += 1) log.push({ timestamp: i, level: 'info', tag: 't', message: `m${i}` });
    expect(log.entries.map((e) => e.message)).toEqual(['m2', 'm3', 'm4']);
    expect(log.truncated).toBe(true);
  });

  test('stop keeps the first entries and a byte budget counts payloads', async () => {
    const { BoundedDebugLog } = await import('../debug-recording');
    const log = new BoundedDebugLog('stop', 100, 1_000);
    log.push({ timestamp: 0, level: 'info', tag: 't', message: 'first' });
    log.push({ timestamp: 1, level: 'info', tag: 't', message: 'big', data: 'x'.repeat(2_000) });
    log.push({ timestamp: 2, level: 'info', tag: 't', message: 'after' });
    expect(log.entries.map((e) => e.message)).toEqual(['first']);
    expect(log.truncated).toBe(true);
  });
});

describe('review fixes (2026-09-24)', () => {
  test('the REC timer reads the provider start time, so a route change cannot reset it', () => {
    const provider = read('components/debug-provider.tsx');
    expect(provider).toContain('recordingStartedAt: number | null;');
    expect(provider).toContain('now > recordingStartedAt');
  });

  test('captured console and network entries are not echoed back, and debug off ends a recording', () => {
    const provider = read('components/debug-provider.tsx');
    expect(provider).toContain("if (isDebugEnabled && tag !== 'console' && tag !== 'net') {");
    expect(provider).toContain('recording.current = null;\n      setIsRecording(false);\n      setRecordingStartedAt(null);\n    };');
  });

  test('"this recording only" is disabled while a recording runs, and tables get unique snapshot names', () => {
    expect(read('components/debug-provider.tsx')).toContain('disabled={!rec || isRecording}');
    expect(read('components/pools/transactions.tsx')).toContain(':${debugTableId}');
  });
});

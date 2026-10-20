import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A cross-chain swap's destination note does not exist until the bridge
// delivers it, so addNotes on the destination session right after the relay
// always failed (false sync warning) and named the note in a commitments(c)
// read. The note must arrive through bulk discovery instead.
const src = readFileSync(join(__dirname, '../../components/swap-modal-provider.tsx'), 'utf8');

function crossChainBranch(): string {
  const start = src.indexOf('Flow 4 diverges here');
  const end = src.indexOf('const { receipt, quote, pendingNote } = await runReshield(', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('cross-chain swap note storage', () => {
  test('never calls addNotes after the relay', () => {
    const branch = crossChainBranch();
    expect(branch).not.toMatch(/\.addNotes\(/);
    expect(branch).not.toMatch(/sessions\.destination[^;]*addNotes/s);
  });
  test('does not raise the note sync warning for a note that cannot exist yet', () => {
    expect(crossChainBranch()).not.toMatch(/setReshieldSyncWarning\(true\)/);
  });
  test('the swap record keeps the prepared note and marks it not stored', () => {
    const branch = crossChainBranch();
    expect(branch).toMatch(/recordCrossChainSwap\(/);
    expect(branch).toMatch(/const crossNoteStored = false;/);
  });
  test('the only addNotes in the swap modal is the same-chain one', () => {
    expect(src.match(/\.addNotes\(/g)?.length).toBe(1);
  });
});

describe('cross-chain delivery does not time a scan to this user\'s deposit', () => {
  const poller = () => {
    const start = src.indexOf('const outcome = bridgeDeliveryOutcome(status);');
    const end = src.indexOf('// Transient status failures', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };
  test('no outcome of the poller starts discovery or a per-note read', () => {
    expect(poller()).not.toMatch(/syncChainNotes|discoverNotes|syncAllChains|syncFromSnapshot|refreshNotes|addNotes|commitments\(|getCommitmentTimestamp/);
  });
  test('the delivered copy says the note shows after the next sync', () => {
    expect(src).toContain("' Shows there after the next sync.'");
  });
  test('no stranded-note bookkeeping remains', () => {
    expect(src).not.toMatch(/strandedNoteRef/);
  });
});

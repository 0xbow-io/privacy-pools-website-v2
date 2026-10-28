// Source-text guards for the recipient autocomplete: every recipient field
// goes through the ONE shared component with the formats it validates, and
// nothing in the contacts code can put a request on the wire.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(new URL('.', import.meta.url).pathname, '..', '..');
const src = (p: string) => readFileSync(join(root, p), 'utf8');

/** The AddressAutocomplete element that wraps the input with `inputTestId`. */
function wrapperFor(file: string, inputTestId: string): string {
  const text = src(file);
  const at = text.indexOf(`testID="${inputTestId}"`);
  expect(at).toBeGreaterThan(0);
  const open = text.lastIndexOf('<AddressAutocomplete', at);
  expect(open).toBeGreaterThan(0);
  const close = text.indexOf('</AddressAutocomplete>', at);
  expect(close).toBeGreaterThan(at);
  // No other wrapper closes between the opening tag and the input.
  expect(text.slice(open, at).includes('</AddressAutocomplete>')).toBe(false);
  const block = text.slice(open, close);
  // The bind is spread onto the input so focus/keys/aria reach it.
  expect(block).toContain('{...bind}');
  return block.slice(0, block.indexOf('>') + 1);
}

const SURFACES: { name: string; file: string; input: string; onSelect: string; formats: string }[] = [
  { name: 'Withdraw', file: 'components/withdraw-modal-provider.tsx', input: 'withdraw-recipient-input', onSelect: 'handleTargetInputChange', formats: "isStellar ? ['stellar'] : isSui ? ['sui'] : ['evm']" },
  { name: 'Send', file: 'components/transfer-modal-provider.tsx', input: 'send-recipient-input', onSelect: 'handleRecipientInputChange', formats: "isStellar ? ['stellar'] : isSui ? ['sui'] : ['evm']" },
  { name: 'Shield, deposit to', file: 'components/home/action-hub.tsx', input: 'hub-shield-recipient-input', onSelect: 'setShieldRecipient', formats: "isStellar ? ['stellar'] : ['evm']" },
  { name: 'Swap tab, send to', file: 'components/home/action-hub.tsx', input: 'hub-swap-recipient-input', onSelect: 'setSwapRecipient', formats: "['evm']" },
  { name: 'Swap, different address', file: 'components/swap-modal-provider.tsx', input: 'swap-recipient-input', onSelect: 'editRecipient', formats: "['evm']" },
];

describe('every recipient field uses the shared autocomplete', () => {
  for (const s of SURFACES) {
    test(`${s.name}: wrapped, picks go through the field's own change handler, formats match its validation`, () => {
      const tag = wrapperFor(s.file, s.input);
      // Picking a row is the same path as typing: the existing validation runs.
      expect(tag).toContain(`onSelect={${s.onSelect}}`);
      expect(tag).toContain(`formats={${s.formats}}`);
    });
  }
});

const CONTACT_FILES = [
  'services/address-book-core.ts',
  'services/address-book-store.ts',
  'services/recipient-suggestions.ts',
  'hooks/use-contacts.ts',
  'components/contacts/address-autocomplete.tsx',
  'components/contacts/address-suggestions-list.tsx',
  'components/contacts/address-suggestions-list.web.tsx',
  'components/contacts/contact-edit-modal.tsx',
  'components/contacts/contacts-modal.tsx',
  'components/contacts/contacts-file.ts',
  'components/contacts/contacts-file.web.ts',
];

describe('contacts code makes no request', () => {
  const NETWORK = [
    /\bfetch\s*\(/, /egress/i, /useQuery|useMutation/, /readContract|getBalance|waitForTransactionReceipt|getBlock\b/,
    /getEnsAddress|getEnsName|resolveEns|normalizeEnsName/, /XMLHttpRequest|WebSocket|sendBeacon/, /@tanstack\/react-query/, /viem\/actions|createPublicClient/,
    /api-client|tor-fetch|public-feed/,
  ];
  for (const f of CONTACT_FILES) {
    test(f, () => {
      const text = src(f).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const re of NETWORK) expect({ file: f, hit: re.test(text) ? re.source : null }).toEqual({ file: f, hit: null });
    });
  }

  test('contacts are keyed on the session identity, never the wagmi account', () => {
    const hook = src('hooks/use-contacts.ts');
    expect(hook).toContain('sessionAddress');
    expect(hook).not.toMatch(/useAccount\s*\(/);
  });

  test('nothing writes the payout index or contacts into another store', () => {
    const hook = src('hooks/use-contacts.ts');
    expect(hook).not.toMatch(/record(WithdrawRecipient|SentTransfer)\s*\(/);
    expect(hook).not.toMatch(/localStorage\.setItem/);
  });
});

describe('focus always answers', () => {
  test('an empty field with nothing to suggest shows the empty state (both platforms)', () => {
    const ac = src('components/contacts/address-autocomplete.tsx');
    expect(ac).toContain("const showEmpty = !disabled && engaged && listState === 'empty';");
    expect(ac).toContain("const showLoading = !disabled && engaged && listState === 'loading';");
    expect(ac).toContain('empty={showEmpty}');
    for (const f of ['components/contacts/address-suggestions-list.tsx', 'components/contacts/address-suggestions-list.web.tsx']) {
      const t = src(f);
      expect(t).toContain('-empty`');
      expect(t).toMatch(/EMPTY_TITLE/);
      // Never from the platform-split module: on web it resolves to the .web file itself.
      expect(t).toContain("from '@/components/contacts/contacts-copy'");
    }
  });
  test('the Activity rows feed the list from memory only', () => {
    const hook = src('hooks/use-contacts.ts');
    expect(hook).toContain('payoutRecordsFromActivity(mine');
    expect(hook).toContain('usePools()');
  });
});

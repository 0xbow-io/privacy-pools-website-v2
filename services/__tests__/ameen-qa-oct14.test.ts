import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(__dirname, '../..', p), 'utf8');

describe('DEV-570 ENS is not supported', () => {
  // services/ens imports config/env, which bun tests cannot load: read it.
  test('the exact copy, no em dash', () => {
    const line = read('services/ens.ts').split('\n').find((l) => l.startsWith('export const ENS_UNSUPPORTED_MESSAGE')) ?? '';
    expect(line).toContain("\"To preserve your privacy, ENS names aren't supported.");
    expect(line).not.toMatch(/—/);
  });

  for (const file of ['components/transfer-modal-provider.tsx', 'components/withdraw-modal-provider.tsx']) {
    test(`${file}: ENS input never resolves and blocks review`, () => {
      const src = read(file);
      // No lookup at all on this path: a request would name the counterparty.
      expect(src).not.toMatch(/resolveEnsAddress|getEnsAddress/);
      // ENS-shaped input gets the message as its field error (review stays off).
      expect(src).toContain('if (isPotentialEnsName(trimmed)) return ENS_UNSUPPORTED_MESSAGE;');
      // Anything else invalid keeps the plain message.
      expect(src).toContain("'Invalid Ethereum address'");
    });
  }
});

describe('DEV-570 every other recipient field', () => {
  test('Shield "Deposit to", Swap tab recipient and the swap modal recipient / fallback show the message', () => {
    const hub = read('components/home/action-hub.tsx');
    expect(hub).toMatch(/isPotentialEnsName\(shieldRecipient\) \? \(\n[^\n]*testID="hub-shield-recipient-ens">\{ENS_UNSUPPORTED_MESSAGE\}<\/Text>/);
    expect(hub).toMatch(/isPotentialEnsName\(swapRecipient\) \? \(\n[^\n]*testID="hub-swap-recipient-ens">\{ENS_UNSUPPORTED_MESSAGE\}<\/Text>/);
    const swap = read('components/swap-modal-provider.tsx');
    expect(swap).toContain("(trimmedRecipient !== '' && isPotentialEnsName(trimmedRecipient))");
    expect(swap).toMatch(/\{isPotentialEnsName\(trimmedRecipient\)\n\s+\? ENS_UNSUPPORTED_MESSAGE\n/);
    // None of them may resolve a name: no ENS lookup outside services/ens.
    for (const f of ['components/home/action-hub.tsx', 'components/swap-modal-provider.tsx', 'components/deposit-modal-provider.tsx']) {
      expect(read(f)).not.toMatch(/resolveEnsAddress|getEnsAddress/);
    }
  });
});

describe('DEV-566 an already-registered wallet is never asked to setAuthPolicy again', () => {
  test('the deposit gate re-reads a "not registered" before prompting', () => {
    const src = read('components/deposit-modal-provider.tsx');
    expect(src).toMatch(/for \(let attempt = 0; !isRegistered && attempt < DEPOSIT_AUTH_LAG_RETRIES; attempt\+\+\) \{[\s\S]{0,200}isRegistered = await depositSession\.isKeystoreRegistered\(\);/);
  });
  test('the modal re-reads before the auth-policy leg and recovers from AuthPolicyAlreadySet', () => {
    const src = read('components/keystore-registration-modal-provider.tsx');
    expect(src).toMatch(/for \(let attempt = 0; attempt < AUTH_LAG_RETRIES && registration\.keystoreCalldata; attempt\+\+\)/);
    // On the revert: re-read and send ONLY the viewing key (or finish).
    expect(src).toMatch(/if \(!isAuthPolicyAlreadySetError\(collectErrorText\(err\)\)\) throw err;\n(?:\s+\/\/[^\n]*\n)?\s+registrationLegSent = false;\n\s+const fresh = await session\.prepareRegisterKeystore\(\);\n\s+viewingKeyCalldata = fresh\.alreadyRegistered \? null : fresh\.viewingKeyCalldata;/);
    // The speculative 4s viewing-key retry is gone.
    expect(src).not.toContain('sendViewingKeyLeg');
  });
});

describe('DEV-573 explorer links carry the privacy note', () => {
  test('names the explorer', async () => {
    const { explorerPrivacyText, explorerNameFromUrl } = await import('../explorer-privacy');
    expect(explorerPrivacyText('Etherscan')).toBe(
      'Opening the explorer shares your IP address with Etherscan and links it to this transaction. Use a VPN or Tor if that matters to you.',
    );
    expect(explorerNameFromUrl('https://www.etherscan.io/tx/0x1')).toBe('etherscan.io');
    expect(explorerNameFromUrl('not a url')).toBe('the explorer');
  });

  test('every Linking.openURL to an explorer sits next to the hint', () => {
    const files = [
      'components/deposit-modal-provider.tsx', 'components/withdraw-modal-provider.tsx',
      'components/transfer-modal-provider.tsx', 'components/swap-modal-provider.tsx',
      'components/ragequit-modal-provider.tsx', 'components/payment-request-modal-provider.tsx',
      'components/home/action-hub.tsx', 'app/pay/[encoded].tsx', 'components/audit-verify-view.tsx',
      'components/payroll/history.tsx', 'components/stellar-claim-note.tsx', 'components/stellar-pay-request.tsx',
    ];
    for (const f of files) {
      const src = read(f);
      // Per link, not per file: each link's own Pressable (inline hint) or
      // the wrapper right after it (sibling hint, before any other Pressable)
      // must carry a hint, so a hint left beside another link cannot count.
      const links = [...src.matchAll(/Linking\.openURL\([^)]*(?:xplorer|getExplorerTxUrl|lifiScan)/g)];
      expect({ f, links: links.length > 0 }).toEqual({ f, links: true });
      for (const m of links) {
        const at = m.index!;
        const open = src.lastIndexOf('<Pressable', at);
        const close = src.indexOf('</Pressable>', at);
        const nextPressable = src.indexOf('<Pressable', close);
        const after = src.slice(close, Math.min(close + 200, nextPressable === -1 ? Infinity : nextPressable));
        const own = src.slice(open, close) + after;
        const line = src.slice(0, at).split('\n').length;
        expect({ f, line, hint: own.includes('<ExplorerPrivacyHint ') }).toEqual({ f, line, hint: true });
      }
    }
    // Menus: red triangle, the note only on hover or tap, never inline.
    for (const m of ['components/pools/transaction-row-menu.tsx', 'components/pools/transaction-row-menu.web.tsx']) {
      expect(read(m)).toContain('<WarningTriangleHint text={item.warning}');
      expect(read(m)).not.toContain('{item.warning}<');
    }
    expect(read('components/pools/transactions.tsx')).toContain('warning: explorerPrivacyText(getExplorerName(tx.chainId))');
    expect(read('components/pools/pool-page-transactions-table.tsx')).toContain('<ExplorerPrivacyHint explorerName={getExplorerName(tx.chainId)}');
  });
});

describe('DEV-568 / DEV-569 / DEV-572', () => {
  test('portfolio rows: kebab on mobile only, Withdraw in the desktop row', () => {
    const src = read('components/portfolio/all-positions.tsx');
    expect(src).toContain('const menuOnly = isMobile || width < 543;');
    expect(src).toContain('const showRowWithdraw = !menuOnly;');
    expect(src).toContain('{!menuOnly ? (');
  });
  test('claim screens: no Advanced, device-only import for key sessions only', () => {
    for (const f of ['app/import-note/[encoded].tsx', 'components/import-note-modal-provider.tsx']) {
      const src = read(f);
      expect(src).not.toMatch(/advancedOpen|>Advanced</);
    }
    expect(read('app/import-note/[encoded].tsx')).toContain('{!canAnchorOnChain && (');
  });
  test('verify page copy', () => {
    const src = read('components/audit-verify-view.tsx');
    expect(src).toContain('The transaction values below are confirmed.');
    expect(src).toContain('{"\\n"}No wallet needed.');
    expect(src).not.toMatch(/on-chain/i);
  });
});

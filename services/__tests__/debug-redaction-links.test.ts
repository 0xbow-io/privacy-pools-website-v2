import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { CryptoService } from '@privacy-pools-v2/sdk';
import { TransactionDataBuilder } from '@mysten/sui/transactions';

// Same stub and env as note-receipt.test.ts / accounting-export.test.ts:
// config/env pulls react-native, and it is evaluated once per process, so the
// values must agree with theirs.
mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_PAY_URL_BASE = 'https://pay.example.test';
process.env.EXPO_PUBLIC_TEST_MODE = 'true';

const { buildSentReceiptUrl, buildRecoveredClaimUrl } = await import('@/services/note-receipt');
const { buildSentPaymentKey, buildVerifyUrl, encodePartialViewingKey } = await import('@/services/audit-receipt');
const { encodePaymentRequestPayloadForUrl, encodePaymentReceiptPayloadForUrl } = await import('@/services/payment-request-codec');
const { encodePasskeyBackup } = await import('@/services/passkey-backup');
const { buildDebugRecording } = await import('@/services/debug-recording');
const { redactValue, REDACTION_LEVELS } = await import('@/services/debug-redaction');
type RedactionLevel = import('@/services/debug-redaction').RedactionLevel;

/**
 * Share links built by the REAL builders: a sent-note receipt and a recovered
 * claim (/import-note), a disclosure bundle (/verify), a payment request (/pay)
 * and a payment receipt (/receive), plus a passkey backup token outside any
 * route. Each carries a note secret or a key in its encoded payload.
 */

type Hex = `0x${string}`;
const RECIPIENT = '0x42bacd8d0c811a2ba95e5d44f9c71d984299e308' as Hex;
const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Hex;
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;
const COMMITMENT = `0x${'1c'.repeat(32)}` as Hex;
const LABEL = `0x${'2d'.repeat(32)}` as Hex;

let noteSecret: Hex;
let rootSecret: Hex;
let links: Record<string, string>;
let passkeyBackup: string;
let pvk: string;

beforeAll(() => {
  const crypto = new CryptoService();
  noteSecret = crypto.generateSecret() as Hex;
  rootSecret = crypto.generateSecret() as Hex;
  const disclosure = { chainId: 11155111, txHash: TX_HASH, commitment: COMMITMENT, ownerAddress: RECIPIENT, noteSecret, tokenId: ETH, value: '0xb5e620f48000' as Hex, label: LABEL };
  pvk = encodePartialViewingKey(buildSentPaymentKey(disclosure, 'rent'));
  const pair = crypto.generateEphemeralKeyPair();
  links = {
    sentReceipt: buildSentReceiptUrl([disclosure])!,
    recoveredClaim: buildRecoveredClaimUrl([{ chainId: 11155111, txHash: TX_HASH, noteSecret, value: '0xb5e620f48000', tokenId: ETH, label: LABEL }])!,
    verify: buildVerifyUrl(pvk),
    pay: `https://pay.example.test/pay/${encodePaymentRequestPayloadForUrl({
      kind: 'ppv2-sdk-payment-request',
      version: 1,
      chainId: 11155111,
      paymentId: `0x${'5a'.repeat(32)}` as Hex,
      tag: `0x${'6b'.repeat(32)}` as Hex,
      paymentPubKey: pair.publicKey as Hex,
      tokenId: ETH,
      amount: '0xb5e620f48000' as Hex,
      noteSecretsMap: [[`0x${'4f'.repeat(32)}` as Hex, noteSecret]],
      createdAt: '2026-09-25T00:00:00.000Z',
    })}`,
    receive: `https://pay.example.test/receive/${encodePaymentReceiptPayloadForUrl({
      kind: 'ppv2-payment-receipt',
      version: 1,
      requestId: 'r1',
      chainId: 11155111,
      recipientAddress: RECIPIENT,
      tokenId: ETH,
      amount: '0xb5e620f48000',
      noteAddressHash: `0x${'4f'.repeat(32)}`,
      commitment: COMMITMENT,
      label: LABEL,
      txHash: TX_HASH,
      createdAt: '2026-09-25T00:00:00.000Z',
    })}`,
  };
  passkeyBackup = encodePasskeyBackup({ root: rootSecret });
});

const lc = (s: string) => s.toLowerCase();

describe('share links', () => {
  test('the real builders put the note secret in the link', () => {
    for (const name of ['sentReceipt', 'recoveredClaim', 'verify']) {
      const seg = links[name].split(/[/#]/).pop()!.replace(/^pvk1\./, '');
      const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      expect(lc(json)).toContain(lc(noteSecret));
    }
  });

  test('Full keeps every link as it is', () => {
    for (const url of Object.values(links)) {
      expect(redactValue({ message: `opened ${url}` }, 'full')).toEqual({ message: `opened ${url}` });
    }
  });

  test('from level 2 the encoded segment of every link route is replaced, in the page URL and in any string', () => {
    for (const level of REDACTION_LEVELS.filter((l): l is Exclude<RedactionLevel, 'full'> => l !== 'full')) {
      for (const [name, url] of Object.entries(links)) {
        // config/env is evaluated once per process: another file may have left PAY_URL_BASE empty, so a link can be relative.
        const [, route, sep] = /\/(pay|receive|import-note|audit|verify)([/#])/.exec(url)!;
        const out = JSON.parse(buildDebugRecording(
          [{ timestamp: 1, level: 'info', tag: 'net', message: `→ #1 GET ${url}`, data: { href: url } }],
          { startedAt: 0, stoppedAt: 2, environment: 'x', url },
          level,
        ));
        const text = JSON.stringify(out);
        expect(out.url).toContain(`/${route}${sep}[redacted:link]`);
        expect(out.entries[0].message).toContain(`/${route}${sep}[redacted:link]`);
        expect(text).not.toContain(url.split(/[/#]/).pop()!);
        expect(lc(text)).not.toContain(lc(noteSecret).slice(2));
        if (name === 'sentReceipt') expect(text).not.toContain('noteSecret');
      }
    }
  });

  test('an encoded payload outside a route is decoded and replaced when it holds a removed field', () => {
    const out = redactValue({
      message: `backup ${passkeyBackup} and bundle ${pvk}`,
      echo: `root was ${rootSecret}`,
    }, 'no-spending-keys');
    expect(out.message).toBe('backup [redacted:spend-key] and bundle [redacted:spend-key]');
    expect(out.echo).toBe('root was [redacted:spend-key]');
  });

  test('an encoded payload with nothing the level removes is left alone', () => {
    const harmless = Buffer.from(JSON.stringify({ hello: 'world', n: 1 })).toString('base64url');
    expect(redactValue({ m: `token ${harmless}` }, 'no-spending-keys')).toEqual({ m: `token ${harmless}` });
  });
});

describe('strings are only rewritten where something is removed', () => {
  const body = '{"jsonrpc":"2.0", "id": 7, "result": 123456789012345678901234567890, "note": "ok"}';

  test('Full leaves a JSON body byte for byte, big numbers included', () => {
    expect(redactValue({ body }, 'full')).toEqual({ body });
  });

  test('a level that removes nothing in it leaves it byte for byte too', () => {
    expect(redactValue({ body }, 'no-spending-keys')).toEqual({ body });
    expect(redactValue({ body }, 'no-viewing-key')).toEqual({ body });
  });

  test('a removed field changes only its own value', () => {
    const withSecret = '{"id": 7, "noteSecret": "0x1234567890abcdef1234567890abcdef", "result": 123456789012345678901234567890}';
    expect(redactValue({ b: withSecret }, 'no-spending-keys')).toEqual({
      b: '{"id": 7, "noteSecret": "[redacted:spend-key]", "result": 123456789012345678901234567890}',
    });
  });
});

describe('Sui transaction digests', () => {
  const digest = TransactionDataBuilder.getDigestFromBytes(new Uint8Array(64).fill(7));

  test('the digest is 32-byte base58', () => {
    expect(digest).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  test('No tx details removes them from the thrown message, RPC bodies and payload fields', () => {
    // hooks/use-sui-session.ts relay confirmation error.
    const thrown = `relayed withdrawal not confirmed on-chain (digest ${digest}): timeout`;
    const rpcBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sui_getTransactionBlock', params: [digest, { showEffects: true }] });
    const input = { thrown, rpcBody, result: { txDigest: digest, digest } };
    const out = redactValue(input, 'no-tx-details');
    expect(JSON.stringify(out)).not.toContain(digest);
    expect(out.thrown).toBe('relayed withdrawal not confirmed on-chain (digest [redacted:tx]): timeout');
    expect(out.result).toEqual({ txDigest: '[redacted:tx]', digest: '[redacted:tx]' });
    expect(out.rpcBody).toContain('sui_getTransactionBlock');
  });

  test('levels below it keep the digest', () => {
    const input = { m: `tx ${digest}`, txDigest: digest };
    expect(redactValue(input, 'no-viewing-key')).toEqual(input);
  });
});

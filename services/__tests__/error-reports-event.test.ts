import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  privateErrorReportEvent,
  ERROR_REPORT_MESSAGES,
  type IncomingEvent,
} from '../error-reports-event';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

/**
 * Values an observer would recognise. Each is planted somewhere Sentry really
 * puts things, and none may come out the other side.
 */
const SECRETS = {
  address: '0x1234567890abcdef1234567890abcdef12345678',
  label: '0x2f1a4c9d1b7e6a5038f2c4d9e8b7a6150c3d2e1f0a9b8c7d6e5f4031223344556',
  commitment: '19283746501928374650192837465019283746501928374650192837465019',
  nullifier: '0x8ab3c1d2e3f405162738495a6b7c8d9eaf0123456789abcdef0123456789abcd',
  amount: '200000000000000',
  recipient: '0xfeedfacefeedfacefeedfacefeedfacefeedface',
  url: 'https://app.privacypools.com/withdraw?amount=0.0002&to=0xfeedface',
  seed: 'excuse solar ribbon casual gadget plastic gown mirror',
};

/**
 * An event shaped the way a real one arrives: the leak is never in one place.
 * The 2026-09-10 disclosure was exactly this - ordinary error context.
 */
function stuffedEvent(): IncomingEvent {
  return {
    event_id: 'a'.repeat(32),
    timestamp: 1789143053.4,
    platform: 'javascript',
    environment: 'prod',
    release: 'deadbeef',
    level: 'fatal',
    message: `withdraw failed: relayer rejected ${SECRETS.amount} to ${SECRETS.recipient}`,
    logger: SECRETS.label,
    transaction: `/withdraw/${SECRETS.commitment}`,
    server_name: SECRETS.address,
    exception: {
      values: [
        {
          type: 'InvalidTransactParams',
          value: `Leaf not found in the leaves array: ${SECRETS.commitment}`,
          stacktrace: {
            frames: [
              { filename: SECRETS.url, function: 'withdraw', vars: { label: SECRETS.label } },
            ],
          },
        },
      ],
    },
    breadcrumbs: [
      { category: 'fetch', data: { url: `${SECRETS.url}&nullifier=${SECRETS.nullifier}` } },
    ],
    request: { url: SECRETS.url, headers: { 'X-Labels': SECRETS.label } },
    user: { id: SECRETS.address, ip_address: '203.0.113.9', email: 'someone@example.com' },
    tags: { pool: SECRETS.address, seed: SECRETS.seed },
    extra: { note: { label: SECRETS.label, value: SECRETS.amount } },
    contexts: {
      withdrawal: { amount: SECRETS.amount, target: SECRETS.recipient },
      errorReport: {
        message: 'withdraw-failed',
        hasAmount: true,
        hasRecipient: false,
        // Everything below is planted INSIDE the one context the module reads.
        amount: SECRETS.amount,
        recipient: SECRETS.recipient,
        label: SECRETS.label,
        // A truthy non-boolean where a flag is expected: the classic way a
        // value rides in on a field that was only ever supposed to be a yes/no.
        hasCommitment: SECRETS.commitment,
        hasStateLeaves: 'true',
      },
    },
  };
}

const serialise = (value: unknown): string => JSON.stringify(value);

describe('the reported event is constructed, not scrubbed', () => {
  test('not one planted value survives, from any of the places Sentry puts them', () => {
    const out = privateErrorReportEvent(stuffedEvent(), { environment: 'prod', release: 'deadbeef' });
    expect(out).not.toBeNull();
    const wire = serialise(out);
    // Collected rather than asserted one by one, so a failure names every
    // value that got through instead of stopping at the first.
    const leaked = Object.entries(SECRETS)
      .filter(([, secret]) => wire.includes(secret))
      .map(([name]) => name);
    expect(leaked).toEqual([]);
  });

  test('the only keys on the wire are the ones named here', () => {
    // A structural ratchet. Construction is only safe while the construction
    // is the whole event: a field added upstream and passed through without
    // being thought about is exactly how the last leak happened.
    const out = privateErrorReportEvent(stuffedEvent(), { environment: 'prod', release: 'deadbeef' })!;
    expect(Object.keys(out).sort()).toEqual(
      ['contexts', 'environment', 'event_id', 'level', 'message', 'platform', 'release', 'timestamp'],
    );
    expect(Object.keys(out.contexts ?? {}).sort()).toEqual(['flags']);
    expect(Object.keys(out.contexts?.flags ?? {}).sort()).toEqual(['hasAmount', 'hasRecipient']);
  });

  test('a flag is kept only when it is really a boolean', () => {
    const out = privateErrorReportEvent({
      contexts: {
        errorReport: {
          message: 'deposit-failed',
          hasAmount: true,
          hasRelayer: false,
          hasQuote: 'true',
          isSwap: 1,
          isBatch: null,
          testMode: undefined,
        },
      },
    })!;
    expect(out.contexts?.flags).toEqual({ hasAmount: true, hasRelayer: false });
  });

  test('a flag name that is not on the list never appears', () => {
    const out = privateErrorReportEvent({
      contexts: { errorReport: { message: 'withdraw-failed', hasSeedPhrase: true, hasLabel: true } },
    })!;
    expect(out.contexts?.flags).toBeUndefined();
  });

  test('the message is picked from the fixed set, never taken from the event', () => {
    const known = privateErrorReportEvent({ contexts: { errorReport: { message: 'transfer-failed' } } })!;
    expect(known.message).toBe(ERROR_REPORT_MESSAGES['transfer-failed']);

    // An unrecognised key, a free-form string, and a missing context all land
    // on the same generic line rather than saying anything specific.
    for (const message of ['not-a-key', `failed sending ${SECRETS.amount}`, undefined]) {
      const out = privateErrorReportEvent({ contexts: { errorReport: { message } } })!;
      expect(out.message).toBe(ERROR_REPORT_MESSAGES['client-failed']);
    }
    expect(privateErrorReportEvent({})!.message).toBe(ERROR_REPORT_MESSAGES['client-failed']);
  });

  test('an egress refusal carries its route-level reason and nothing more', () => {
    const out = privateErrorReportEvent({
      contexts: {
        errorReport: {
          message: 'egress-refused',
          egressParty: 'asp',
          egressReason: 'undeclared ASP route',
        },
      },
    })!;
    expect(out.level).toBe('warning');
    expect(out.contexts?.egress).toEqual({ reason: 'undeclared ASP route', party: 'asp' });
  });

  test('a refusal reason is length-capped, so it cannot become a payload', () => {
    const out = privateErrorReportEvent({
      contexts: {
        errorReport: { message: 'egress-refused', egressReason: 'x'.repeat(5000), egressParty: 'y'.repeat(5000) },
      },
    })!;
    expect(out.contexts?.egress?.reason.length).toBe(300);
    expect(out.contexts?.egress?.party.length).toBe(20);
  });

  test('a non-string reason is dropped rather than coerced', () => {
    const out = privateErrorReportEvent({
      contexts: { errorReport: { message: 'egress-refused', egressReason: { label: SECRETS.label } } },
    })!;
    expect(out.contexts?.egress).toBeUndefined();
    expect(serialise(out).includes(SECRETS.label)).toBe(false);
  });

  test('event_id is forwarded only in the shape the SDK mints', () => {
    // The envelope header addresses the event by this id, so dropping it is a
    // delivery question - but anything that is not a 32-hex id is not an id.
    expect(privateErrorReportEvent({ event_id: 'b'.repeat(32) })!.event_id).toBe('b'.repeat(32));
    for (const bad of [SECRETS.address, 'B'.repeat(32), 'b'.repeat(31), 42, null]) {
      expect(privateErrorReportEvent({ event_id: bad })!.event_id).toBeUndefined();
    }
  });

  test('timestamp is forwarded only as a number', () => {
    expect(privateErrorReportEvent({ timestamp: 1789143053.4 })!.timestamp).toBe(1789143053.4);
    for (const bad of ['1789143053', Number.NaN, 0, -1, { t: 1 }]) {
      expect(privateErrorReportEvent({ timestamp: bad })!.timestamp).toBeUndefined();
    }
  });

  test('environment and release come from us, never from the event', () => {
    const out = privateErrorReportEvent(
      { environment: SECRETS.address, release: SECRETS.label },
      { environment: 'staging', release: 'abc123' },
    )!;
    expect(out.environment).toBe('staging');
    expect(out.release).toBe('abc123');
    // No meta at all means no labels, not the event's own.
    const bare = privateErrorReportEvent({ environment: SECRETS.address, release: SECRETS.label })!;
    expect(bare.environment).toBeUndefined();
    expect(bare.release).toBeUndefined();
    expect(serialise(bare).includes(SECRETS.address)).toBe(false);
  });

  test('an over-long label is dropped rather than truncated into the wire', () => {
    const out = privateErrorReportEvent({}, { environment: 'e'.repeat(65), release: 'r'.repeat(65) })!;
    expect(out.environment).toBeUndefined();
    expect(out.release).toBeUndefined();
  });

  test('nothing in means nothing out', () => {
    expect(privateErrorReportEvent(null)).toBeNull();
    expect(privateErrorReportEvent(undefined)).toBeNull();
  });

  test('the platform is stated, not inherited', () => {
    expect(privateErrorReportEvent({ platform: 'node' })!.platform).toBe('javascript');
  });
});

/**
 * The allowlist is only the whole story while it is the ONLY way to Sentry.
 *
 * `Sentry.captureException(err)` anywhere else would still be filtered by
 * `beforeSend` - but it would also be a standing invitation to relax that
 * filter "just for this one call site", which is how the original leak was
 * written. One file talks to the SDK.
 */
describe('only one module may speak to the reporter', () => {
  const SCANNED_DIRS = ['services', 'components', 'hooks', 'app', 'config'];
  const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '__tests__']);
  const ALLOWED = new Set(['services/error-reports-sentry.web.ts']);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  }

  const files = SCANNED_DIRS.flatMap((dir) => walk(join(ROOT, dir)));

  test('the scan actually reaches the app', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith('services/error-reports-sentry.web.ts'))).toBe(true);
  });

  test('no other file imports the Sentry SDK', () => {
    const offenders = files.filter((file) => {
      const rel = relative(ROOT, file);
      if (ALLOWED.has(rel)) return false;
      return /from\s+'@sentry\/|require\(\s*'@sentry\//.test(code(file));
    });
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  /** Prose naming a capture API is fine; a call is not. Comments come out first. */
  const code = (file: string): string =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('the comment stripper does not simply blank the file', () => {
    // Otherwise both scans below would pass by scanning nothing.
    const source = code(join(ROOT, 'services/error-reports-event.ts'));
    expect(source).toContain('export function privateErrorReportEvent');
    expect(source).not.toContain('captureException');
  });

  test('no other file calls a capture API', () => {
    const offenders = files.filter((file) => {
      const rel = relative(ROOT, file);
      if (ALLOWED.has(rel)) return false;
      return /\b(captureException|captureMessage|captureEvent)\s*\(/.test(code(file));
    });
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  test('every report says which environment it came from', () => {
    // prod and staging are separate worlds end to end (separate ASP, relayer,
    // pools and chains), so a report that does not say which one it is from
    // is a report you cannot act on. Asserted at the wiring, because the
    // constructor cannot know whether its caller passed anything.
    const source = readFileSync(join(ROOT, 'services/error-reports.ts'), 'utf8');
    expect(source).toContain('environment: ACTIVE_APP_ENVIRONMENT');
    expect(source).toContain("from '@/config/app-environment'");
    // And it survives construction.
    const out = privateErrorReportEvent(
      { contexts: { errorReport: { message: 'withdraw-failed' } } },
      { environment: 'staging' },
    )!;
    expect(out.environment).toBe('staging');
  });

  test('the one allowed file really is configured to collect nothing', () => {
    const source = readFileSync(join(ROOT, 'services/error-reports-sentry.web.ts'), 'utf8');
    for (const required of [
      'defaultIntegrations: false',
      'integrations: []',
      'sendDefaultPii: false',
      'tracesSampleRate: 0',
      'maxBreadcrumbs: 0',
      'sendClientReports: false',
      'beforeBreadcrumb: () => null',
      'beforeSendTransaction: () => null',
      'privateErrorReportEvent',
    ]) {
      expect(source.includes(required)).toBe(true);
    }
  });
});

/**
 * The gate on `contexts.diagnostic`.
 *
 * This is the only path in the app by which an address, an amount or a raw
 * error string can reach an error reporter, so it is the only part of this
 * module where "the allowlist holds" is not the whole argument. The argument
 * is that the gate is closed by default and needs two independent yeses.
 */
describe('values, and only in a staging test build', () => {
  const bag = {
    stage: 'relay',
    detail: 'HttpError: relayer said no',
    address: '0xd3f927692168c7912189d95B1fB073eB0394dB15',
    amount: '0.001',
    asset: 'ETH',
    chainId: 11155111,
  };
  const event = (flags: Record<string, unknown> = {}) => ({
    contexts: { errorReport: { message: 'withdraw-failed', ...flags, diagnostic: bag } },
  });

  test('sends nothing when the build is not allowed, however the event is flagged', () => {
    for (const meta of [{}, { diagnosticsAllowed: false }, { environment: 'staging' }]) {
      expect(privateErrorReportEvent(event(), meta)!.contexts?.diagnostic).toBeUndefined();
    }
  });

  test('sends the reviewed keys when the session is staging', () => {
    const out = privateErrorReportEvent(event(), { diagnosticsAllowed: true })!;
    expect(out.contexts?.diagnostic).toEqual({
      stage: 'relay',
      detail: 'HttpError: relayer said no',
      address: '0xd3f927692168c7912189d95B1fB073eB0394dB15',
      amount: '0.001',
      asset: 'ETH',
      // A number arrives as one and leaves as a string.
      chainId: '11155111',
    });
  });

  test('an unlisted key does not ride along, even through the open gate', () => {
    const out = privateErrorReportEvent(
      {
        contexts: {
          errorReport: {
            message: 'withdraw-failed',
            diagnostic: { address: '0xabc', commitment: '0xdeadbeef', nullifier: '0xfeed', note: { secret: 1 } },
          },
        },
      },
      { diagnosticsAllowed: true },
    )!;
    expect(out.contexts?.diagnostic).toEqual({ address: '0xabc' });
  });

  test('a long error string is capped rather than carried whole', () => {
    const out = privateErrorReportEvent(
      {
        contexts: {
          errorReport: { message: 'withdraw-failed', diagnostic: { detail: 'x'.repeat(5_000) } },
        },
      },
      { diagnosticsAllowed: true },
    )!;
    expect(out.contexts?.diagnostic?.detail.length).toBe(300);
  });

  test('an empty or non-object bag leaves the context absent, not empty', () => {
    for (const diagnostic of [undefined, null, {}, 'address=0xabc', ['0xabc'], { detail: '' }]) {
      const out = privateErrorReportEvent(
        { contexts: { errorReport: { message: 'withdraw-failed', diagnostic } } },
        { diagnosticsAllowed: true },
      )!;
      expect(out.contexts?.diagnostic).toBeUndefined();
    }
  });

  test('the gate is the environment or debug mode, and nothing else', () => {
    const source = readFileSync(join(ROOT, 'services/error-reports.ts'), 'utf8');
    const gate = source.slice(source.indexOf('const diagnosticsAllowed'), source.indexOf('let stopEgressRelay'));
    expect(gate).toContain("ACTIVE_APP_ENVIRONMENT === 'staging'");

    // This assertion used to be `not.toContain('||')`, on the reasoning that a
    // second condition could open the gate on a real-money session. It can,
    // and that is now the requested behaviour: a user who has turned debug
    // mode on is diagnosing their own session deliberately (Pat, 2026-09-22:
    // "make it send all when user is in debug mode, even in prod").
    //
    // So the ratchet moved rather than came off. EXACTLY ONE `||`, and the
    // thing on the other side of it is the debug switch by name. A third
    // condition, or a different second one, fails here and has to be decided
    // rather than added.
    expect(gate.match(/\|\|/g)).toEqual(['||']);
    expect(gate).toContain('debugModeOn()');

    // And the switch itself reads the debug flag and nothing else.
    const fn = source.slice(source.indexOf('function debugModeOn'), source.indexOf('let stopEgressRelay'));
    expect(fn).toContain("localStorage.getItem('ppv2_debug') === '1'");
  });

  test('a prod-environment session sends no values, whatever the event claims', () => {
    // Real funds, debug off: no values. Flags a caller might set cannot reopen
    // it, because the decision is not read off the event at all. Debug mode
    // does reopen it, and it does so through `meta`, which is why this case
    // supplies no `diagnosticsAllowed` at all.
    for (const flags of [{}, { testMode: true }, { testMode: false }, { isUserRejected: true }]) {
      const out = privateErrorReportEvent(
        {
          contexts: {
            errorReport: {
              message: 'withdraw-failed',
              ...flags,
              diagnostic: { address: '0xabc', amount: '1.5', detail: 'boom' },
            },
          },
        },
        // What a prod session supplies: the environment label, and no yes.
        { environment: 'prod' },
      )!;
      expect(out.contexts?.diagnostic).toBeUndefined();
    }
  });
});

/**
 * The two things a production session sends, and the gate that lets a debug
 * session send the rest (Pat, 2026-09-22).
 *
 * The rule that makes `code` safe is that an identifier is source text. So the
 * cases worth writing are the ones that look like an identifier and are not:
 * an address, an amount, a symbol, a formatted error. Each is refused by a
 * different character, which is the point of testing them separately.
 */
describe('the code bag travels everywhere, so it carries only identifiers', () => {
  const code = (bag: Record<string, unknown>) =>
    privateErrorReportEvent({ contexts: { errorReport: { message: 'client-failed', code: bag } } }, {})
      ?.contexts?.code;

  test('a class name and a component name survive, in prod, ungated', () => {
    // No `diagnosticsAllowed` at all: this is the real-money case.
    expect(code({ errorName: 'TypeError', componentFrame: 'SwapModalProvider' }))
      .toEqual({ errorName: 'TypeError', componentFrame: 'SwapModalProvider' });
  });

  test('a value shaped like a name does not', () => {
    for (const value of [
      '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', // digit after 0x... and the leading 0
      '19.881337',
      '12 USDC',
      'TypeError: cannot read 0x7f45 of undefined',
      'ppUSDC/0x9Ea986Bc',
      'withdraw-failed',                              // a hyphen is not an identifier character
      '',
    ]) {
      expect({ value, sent: code({ errorName: value }) }).toEqual({ value, sent: undefined });
    }
  });

  test('a number is refused rather than stringified', () => {
    // The diagnostic bag stringifies a chain id on purpose. Doing that here
    // would turn every numeric value into a sendable one.
    expect(code({ errorName: 11155111 })).toBeUndefined();
  });

  test('length is checked before truncation, so a long value cannot be trimmed into one', () => {
    expect(code({ errorName: `Error${'x'.repeat(200)}` })).toBeUndefined();
  });

  test('an unknown key is dropped even when its value is an identifier', () => {
    expect(code({ walletName: 'MetaMask' })).toBeUndefined();
  });
});

describe('debug mode opens the diagnostic gate, anywhere', () => {
  const detail = (allowed: boolean | (() => boolean) | undefined) =>
    privateErrorReportEvent(
      { contexts: { errorReport: { message: 'client-failed', diagnostic: { detail: 'TypeError: x' } } } },
      { diagnosticsAllowed: allowed },
    )?.contexts?.diagnostic;

  test('a thunk is honoured, both ways', () => {
    expect(detail(() => true)).toEqual({ detail: 'TypeError: x' });
    expect(detail(() => false)).toBeUndefined();
  });

  test('a thunk is read per event, so flipping the switch takes effect', () => {
    let on = false;
    const gate = () => on;
    expect(detail(gate)).toBeUndefined();
    on = true;
    expect(detail(gate)).toEqual({ detail: 'TypeError: x' });
  });

  test('a throwing thunk is closed, like an absent one', () => {
    // What a blocked localStorage does.
    expect(detail(() => { throw new Error('blocked'); })).toBeUndefined();
    expect(detail(undefined)).toBeUndefined();
  });

  test('a boolean still works', () => {
    expect(detail(true)).toEqual({ detail: 'TypeError: x' });
    expect(detail(false)).toBeUndefined();
  });
});

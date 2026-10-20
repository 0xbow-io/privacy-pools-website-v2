import { describe, expect, test } from 'bun:test';
import { AddressSchema, RelayerInteractor } from '@privacy-pools-v2/sdk';

// DEV-370. The disclosed ("Hide my address" off) transfer self-submits from the
// user's wallet and never relays, but the SDK's prepareTransfer fetches a
// COMMITTING transfer quote before it proves, with no parameter to skip it
// (`buildPrepareTransferResult` → `settleTransferRelayerQuotes`, commit: true).
// `settleRelayerQuotes` then throws when every configured relayer fails, so on a
// chain the relayer does not serve the send died on a quote it would have
// discarded, and reserved a fee commitment for a relay that never happens.
//
// `createRelayerlessInteractor` (services/sdk-setup) is the way out, and it rests
// on one line of SDK behaviour: `if (relayers.length > 0 && result.length === 0)`.
// Zero relayers ⇒ nothing requested and the throw unreachable.
//
// (The factory itself isn't imported here — services/sdk-setup pulls
// react-native transitively, which the bun test runtime can't parse.)
describe('relayer-less transfer preparation (disclosed self-submit)', () => {
  test('the SDK relayer interactor CANNOT be built with an empty list', () => {
    // Which is why createRelayerlessInteractor hand-rolls the interface instead
    // of configuring the SDK class with `relayers: []`. Caught in review: that
    // construction throws before the session exists.
    expect(() => new RelayerInteractor({
      relayers: [],
      httpClient: { get: async () => ({}), post: async () => ({}) } as never,
      addressSchema: AddressSchema,
    })).toThrow(/At least one relayer is required/);
  });

  // CANARY, not a proof (agy). Grepping the shipped bundle cannot show that the
  // disclosed path works: a future SDK could keep this guard and still break us
  // by throwing somewhere new, and minification could rename its way past the
  // pattern. What it does buy is a loud failure on the one silent regression
  // that nothing else here would catch — the guard being dropped outright, which
  // would restore the dead end with every other test still green. The behaviour
  // used to be proven on-chain by the `send-disclosed` e2e phase; that phase was
  // retired 2026-08-29 with the "Hide my wallet" toggle (every send is relayed
  // now), so this canary is what remains.
  test('canary: the SDK still guards its all-relayers-failed throw on a non-empty list', async () => {
    const bundle = await Bun.file(
      require.resolve('@privacy-pools-v2/sdk').replace(/\/[^/]+$/, '/index.js'),
    ).text();
    const flat = bundle.replace(/\s+/g, '');
    // Whitespace-insensitive, and tolerant of the operands being reordered.
    const guarded = /relayers\.length>0&&result\.length===0/.test(flat)
      || /result\.length===0&&relayers\.length>0/.test(flat);
    expect(guarded).toBe(true);
    // If the SDK ever ships minified, the pattern above stops meaning anything,
    // so say that out loud rather than letting a renamed bundle read as a pass.
    expect(flat).toContain('settleRelayerQuotes');
  });
});

// The both-or-neither rule for a cross-chain reshield session's destination.
// The SDK builds its reshieldCrosschain delegate only when the chain id AND the
// destination entrypoint interactor are both present; a lone chain id is
// ignored, producing a session whose reshield methods throw at call time.
import { describe, expect, test } from 'bun:test';

import { buildReshieldDestinationKeys } from '@/services/reshield-destination';

const INTERACTOR = { tag: 'destination-entrypoint' };

describe('buildReshieldDestinationKeys', () => {
  test('both present ⇒ both keys, so the SDK builds the delegate', () => {
    expect(buildReshieldDestinationKeys({ chainId: 10 }, INTERACTOR)).toEqual({
      destinationChainId: 10,
      destinationEntrypointInteractor: INTERACTOR,
    });
  });

  test('neither present ⇒ no keys at all, leaving the config untouched', () => {
    // Not `{destinationChainId: undefined}`: an explicit undefined key would
    // still appear in the spread, and the SDK checks `!== void 0`.
    expect(buildReshieldDestinationKeys(undefined, undefined)).toEqual({});
    expect(Object.keys(buildReshieldDestinationKeys(undefined, undefined))).toEqual([]);
  });

  test('a destination without an interactor contributes NOTHING', () => {
    // The dangerous half: a lone chain id is silently ignored by the SDK, so
    // the session would look configured and fail inside the flow.
    const keys = buildReshieldDestinationKeys({ chainId: 10 }, undefined);
    expect(keys).toEqual({});
    expect('destinationChainId' in keys).toBe(false);
  });

  test('an interactor without a destination contributes nothing either', () => {
    expect(buildReshieldDestinationKeys(undefined, INTERACTOR)).toEqual({});
  });

  test('null is treated as absent, not as a value', () => {
    // createEntrypointInteractor never returns null today, but a caller reading
    // from a nullable source must not be able to half-configure the session.
    expect(buildReshieldDestinationKeys({ chainId: 1 }, null)).toEqual({});
  });

  test('chain 0 is a chain id, not a falsy blank', () => {
    // Defensive: the guard must test presence, never truthiness — a `!chainId`
    // check would drop a legitimate id and half-configure nothing.
    expect(buildReshieldDestinationKeys({ chainId: 0 }, INTERACTOR)).toEqual({
      destinationChainId: 0,
      destinationEntrypointInteractor: INTERACTOR,
    });
  });
});

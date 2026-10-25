import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  parseRegistrationTopUpChains,
  REGISTRATION_GAS_TOP_UP_CHAINS,
  registrationTopUpEnabled,
} from '@/config/cold-start';
import {
  convergeFeeOnlyQuote,
  decideRegistrationPath,
  planFeeOnlyClaim,
} from '@/services/cold-start-claim';
import { describeQuoteFailure } from '@/services/gasless-registration';
import {
  acceptReceiveSetup,
  describePublishViewingKey,
  FINISH_SETUP_AUTO_OPENED_KEY,
  FINISH_SETUP_BANNER,
  FINISH_SETUP_FROM_CLAIM_KEY,
  getReceiveSetup,
  joinChainNames,
  markFinishSetupFromClaim,
  partialReceiveChains,
  receiveSetupFromIdentity,
  receiveSetupVersion,
  resetReceiveSetupStore,
  setReceiveSetup,
  subscribeReceiveSetup,
  takeFinishSetupAutoOpen,
  VIEWING_KEY_GAS_LIMIT,
  viewingKeyCostWei,
  type ReceiveSetupState,
} from '@/services/receive-setup';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const OWNER = '0x1111111111111111111111111111111111111111';

afterEach(() => resetReceiveSetupStore());

describe('the gas top-up flag', () => {
  test('is on for Ethereum, BNB Chain and Citrea by default', () => {
    expect([...REGISTRATION_GAS_TOP_UP_CHAINS].sort((a, b) => a - b)).toEqual([1, 56, 4114]);
    for (const chainId of [1, 56, 4114]) expect(registrationTopUpEnabled(chainId)).toBe(true);
    expect(registrationTopUpEnabled(10)).toBe(false);
    expect(registrationTopUpEnabled(11155111)).toBe(false);
  });

  test('an env list replaces the default, and empty or "none" turns it off', () => {
    expect(parseRegistrationTopUpChains('56')).toEqual([56]);
    expect(registrationTopUpEnabled(1, '56')).toBe(false);
    expect(registrationTopUpEnabled(56, ' 56 , 10 ')).toBe(true);
    expect(parseRegistrationTopUpChains('')).toEqual([]);
    expect(parseRegistrationTopUpChains('none')).toEqual([]);
    expect(parseRegistrationTopUpChains(undefined)).toEqual(REGISTRATION_GAS_TOP_UP_CHAINS);
  });

  test('malformed entries are dropped, not fatal', () => {
    expect(parseRegistrationTopUpChains('1,abc,-3,0,1.5,56,56')).toEqual([1, 56]);
  });
});

describe('a fee-only plan converges with the top-up in the fee', () => {
  // Fee = flat relay cost + bps × amount + top-up priced in the pool token.
  const relayer = (input: { relayCost: bigint; bps: bigint; topUpInToken: bigint }) =>
    async (amountWei: bigint) => {
      // The real /receive shape: `amount` is the payout, amountSent = amount + fee.
      const fee = input.relayCost + (amountWei * input.bps) / 10_000n + input.topUpInToken;
      return { amountSent: (amountWei + fee).toString(), feeAmount: fee.toString() };
    };

  test('lands at amountSent == fee > 0 and leaves the rest shielded', async () => {
    const quoteFor = relayer({ relayCost: 600_000n, bps: 10n, topUpInToken: 1_500_000n });
    const noteValueWei = 5_120_000n;
    const initialQuote = await quoteFor(noteValueWei);
    const { quote, tightened } = await convergeFeeOnlyQuote({ initialQuote, quoteFor });
    expect(tightened).toBe(true);
    const plan = planFeeOnlyClaim({
      noteValueWei,
      amountSentWei: BigInt(quote.amountSent),
      feeAmountWei: BigInt(quote.feeAmount),
    });
    expect(plan.grossWei).toBeGreaterThan(0n);
    expect(plan.payoutWei).toBe(0n);
    expect(plan.changeWei).toBe(noteValueWei - plan.grossWei);
    expect(plan.changeWei).toBeGreaterThan(0n);
    expect(plan.grossWei).toBeGreaterThanOrEqual(2_100_000n);
  });

  test('a balance the fee plus top-up consumes whole is refused, not zeroed', async () => {
    expect(() => planFeeOnlyClaim({ noteValueWei: 2_102_100n, amountSentWei: 2_102_100n, feeAmountWei: 2_102_100n }))
      .toThrow(/nothing left/);
  });
});

describe('the eligibility minimum', () => {
  test('names the minimum and says it covers the gas for the last step', () => {
    const line = describeQuoteFailure('fee-exceeds-balance', 'ETH', { minimum: '2.1021 USDC', withTopUp: true });
    expect(line).toContain('Needs at least 2.1021 USDC shielded');
    expect(line).toContain('gas for the final step');
    expect(line).toMatch(/Nothing was sent/);
    expect(line).not.toContain('—');
  });

  test('without a top-up it names only the relay fee', () => {
    const line = describeQuoteFailure('fee-exceeds-balance', 'BNB', { minimum: '0.4 USDT', withTopUp: false });
    expect(line).toContain('to cover the relay fee.');
    expect(line).not.toContain('final step');
  });

  test('an outage never reads as a balance problem, minimum or not', () => {
    const line = describeQuoteFailure('relayer-unavailable', 'ETH', { minimum: '1 USDC', withTopUp: true });
    expect(line).toMatch(/can't be reached/);
    expect(line).not.toContain('Needs at least');
  });

  test('a top-up for the viewing key only has to afford setViewingKey', () => {
    const gasPriceWei = 2_000_000_000n;
    const enoughForKey = viewingKeyCostWei({ gasPriceWei });
    const decision = decideRegistrationPath({
      supported: true,
      balanceWei: enoughForKey,
      gasPriceWei,
      gasLimit: VIEWING_KEY_GAS_LIMIT,
    });
    expect(decision.path).toBe('self-register');
    expect(decideRegistrationPath({ supported: true, balanceWei: enoughForKey, gasPriceWei }).path)
      .toBe('relayed-claim');
  });
});

describe('the viewing-key cost check', () => {
  test('is (estimate × 1.2) × (2 × gas price + the chain tip floor), and falls back to the static budget', () => {
    expect(viewingKeyCostWei({ gasPriceWei: 10n, gasEstimate: 51_000n, chainId: 1 })).toBe(61_200n * (20n + 100_000_000n));
    const perGas = 2n * 10n; // no floor off Ethereum
    expect(viewingKeyCostWei({ gasPriceWei: 10n, gasEstimate: 51_000n })).toBe(61_200n * perGas);
    expect(viewingKeyCostWei({ gasPriceWei: 10n, gasEstimate: null })).toBe(((VIEWING_KEY_GAS_LIMIT * 12n) / 10n) * perGas);
    expect(viewingKeyCostWei({ gasPriceWei: 10n, gasEstimate: 0n })).toBe(((VIEWING_KEY_GAS_LIMIT * 12n) / 10n) * perGas);
  });

  test('a ~0.0006 ETH top-up covers it at mainnet gas prices', () => {
    const topUp = 587_000_000_000_000n;
    expect(viewingKeyCostWei({ gasPriceWei: 2_000_000_000n, gasEstimate: 51_000n })).toBeLessThan(topUp);
    expect(viewingKeyCostWei({ gasPriceWei: 2_000_000_000n, gasEstimate: 51_000n }) * 2n).toBeLessThan(topUp);
  });
});

describe('the partial state machine', () => {
  test('identity reads map onto the receive question', () => {
    expect(receiveSetupFromIdentity('compatible')).toBe('complete');
    expect(receiveSetupFromIdentity('partial')).toBe('partial');
    expect(receiveSetupFromIdentity('unregistered')).toBe('unregistered');
    expect(receiveSetupFromIdentity('incompatible')).toBe('incompatible');
    expect(receiveSetupFromIdentity('unknown')).toBe('unknown');
  });

  test('a local hint can mark a chain partial, and can never clear it', () => {
    const states: (ReceiveSetupState | undefined)[] = [undefined, 'unknown', 'unregistered', 'partial', 'incompatible'];
    for (const previous of states) expect(acceptReceiveSetup(previous, 'partial', 'local')).toBe(true);
    for (const previous of states) expect(acceptReceiveSetup(previous, 'complete', 'local')).toBe(false);
    expect(acceptReceiveSetup('complete', 'partial', 'local')).toBe(false);
  });

  test('onchain answers win, except a failed read over a known state', () => {
    expect(acceptReceiveSetup('partial', 'complete', 'onchain')).toBe(true);
    expect(acceptReceiveSetup('unregistered', 'partial', 'onchain')).toBe(true);
    expect(acceptReceiveSetup('partial', 'unknown', 'onchain')).toBe(false);
    expect(acceptReceiveSetup(undefined, 'unknown', 'onchain')).toBe(true);
  });

  test('a lagging read never takes a chain back from complete', () => {
    expect(acceptReceiveSetup('complete', 'partial', 'onchain')).toBe(false);
    expect(acceptReceiveSetup('complete', 'unregistered', 'onchain')).toBe(false);
    expect(acceptReceiveSetup('complete', 'unknown', 'onchain')).toBe(false);
    expect(acceptReceiveSetup('complete', 'incompatible', 'onchain')).toBe(true);
    setReceiveSetup(OWNER, 1, 'partial', 'local');
    setReceiveSetup(OWNER, 1, 'complete', 'onchain');
    expect(setReceiveSetup(OWNER, 1, 'partial', 'onchain')).toBe(false);
    expect(getReceiveSetup(OWNER, 1)).toBe('complete');
    expect(partialReceiveChains(OWNER)).toEqual([]);
  });

  test('gasless registration → partial → viewing key published → complete', () => {
    expect(getReceiveSetup(OWNER, 1)).toBe('unknown');
    expect(setReceiveSetup(OWNER, 1, 'partial', 'local')).toBe(true);
    expect(getReceiveSetup(OWNER, 1)).toBe('partial');
    expect(setReceiveSetup(OWNER, 1, 'complete', 'local')).toBe(false);
    expect(getReceiveSetup(OWNER, 1)).toBe('partial');
    expect(setReceiveSetup(OWNER, 1, 'complete', 'onchain')).toBe(true);
    expect(getReceiveSetup(OWNER, 1)).toBe('complete');
    expect(setReceiveSetup(OWNER, 1, 'partial', 'local')).toBe(false);
  });

  test('state is per address and per chain, case-insensitive on the address', () => {
    setReceiveSetup(OWNER, 1, 'partial', 'local');
    setReceiveSetup(OWNER.toLowerCase(), 56, 'partial', 'onchain');
    setReceiveSetup(OWNER, 4114, 'complete', 'onchain');
    setReceiveSetup('0x0000000000000000000000000000000000000001', 10, 'partial', 'local');
    expect(partialReceiveChains(OWNER)).toEqual([1, 56]);
    expect(getReceiveSetup(OWNER.toLowerCase(), 1)).toBe('partial');
    expect(getReceiveSetup(null, 1)).toBe('unknown');
    expect(setReceiveSetup(undefined, 1, 'partial', 'local')).toBe(false);
  });

  test('subscribers hear changes, and only changes', () => {
    let calls = 0;
    const unsubscribe = subscribeReceiveSetup(() => { calls += 1; });
    const before = receiveSetupVersion();
    setReceiveSetup(OWNER, 1, 'partial', 'local');
    setReceiveSetup(OWNER, 1, 'partial', 'local');
    setReceiveSetup(OWNER, 1, 'complete', 'local');
    expect(calls).toBe(1);
    expect(receiveSetupVersion()).toBe(before + 1);
    unsubscribe();
    setReceiveSetup(OWNER, 1, 'complete', 'onchain');
    expect(calls).toBe(1);
  });
});

describe('the Finish setup auto-open', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v); },
      removeItem: (k: string) => { data.delete(k); },
      data,
    };
  };

  test('opens once per session', () => {
    const store = memory();
    expect(takeFinishSetupAutoOpen(store)).toBe(true);
    expect(store.data.get(FINISH_SETUP_AUTO_OPENED_KEY)).toBe('1');
    expect(takeFinishSetupAutoOpen(store)).toBe(false);
    expect(takeFinishSetupAutoOpen(store)).toBe(false);
  });

  test('arriving from the claim page opens it regardless, once', () => {
    const store = memory();
    expect(takeFinishSetupAutoOpen(store)).toBe(true);
    markFinishSetupFromClaim(store);
    expect(store.data.get(FINISH_SETUP_FROM_CLAIM_KEY)).toBe('1');
    expect(takeFinishSetupAutoOpen(store)).toBe(true);
    expect(store.data.has(FINISH_SETUP_FROM_CLAIM_KEY)).toBe(false);
    expect(takeFinishSetupAutoOpen(store)).toBe(false);
  });

  test('storage that throws errs toward the prompt', () => {
    const broken = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('SecurityError'); },
      removeItem: () => { throw new Error('SecurityError'); },
    };
    expect(takeFinishSetupAutoOpen(broken)).toBe(true);
    expect(takeFinishSetupAutoOpen(null)).toBe(true);
    expect(() => markFinishSetupFromClaim(broken)).not.toThrow();
  });

  test('the banner has no dismiss', () => {
    const banner = read('components/home/finish-setup-banner.tsx');
    expect(banner).not.toMatch(/dismiss(ed)?\s*[=:(]/i);
    expect(banner).not.toMatch(/localStorage/);
    expect(banner).toContain('useReceiveSetup');
  });
});

describe('copy', () => {
  test('the last step names the ETH received when it is known', () => {
    expect(describePublishViewingKey({ received: '0.00058 ETH', estimate: '0.0001 ETH' }))
      .toBe('Publish your viewing key so people can send to you privately. Uses about 0.0001 ETH of the 0.00058 ETH you just received.');
    expect(describePublishViewingKey({ received: null, estimate: null })).toMatch(/one wallet transaction/);
  });

  test('chain lists read as a sentence', () => {
    expect(joinChainNames(['Ethereum'])).toBe('Ethereum');
    expect(joinChainNames(['Ethereum', 'BNB Chain'])).toBe('Ethereum and BNB Chain');
    expect(joinChainNames(['Ethereum', 'BNB Chain', 'Citrea'])).toBe('Ethereum, BNB Chain and Citrea');
  });

  test('copy has no em dashes', () => {
    expect(FINISH_SETUP_BANNER).not.toContain('—');
    const source = read('services/receive-setup.ts');
    const strings = source.match(/'[^'\n]*'/g) ?? [];
    for (const literal of strings) expect(literal).not.toContain('—');
  });
});

describe('wiring', () => {
  test('an auth-only anchor no longer marks the chain registered', () => {
    const source = read('hooks/use-note-import.ts');
    const relayedBlock = source.slice(
      source.indexOf("if (relayed.mode === 'register-and-withdraw') {", source.indexOf('setClaimGasTopUpWei(claimTopUpWei)')),
      source.indexOf('} else {\n        const registration = await session.prepareRegisterKeystore();'),
    );
    expect(relayedBlock.length).toBeGreaterThan(0);
    expect(relayedBlock).not.toContain('markRegistered(');
    expect(relayedBlock).toContain("setReceiveSetup(sessionAddress, chainId, 'partial', 'local')");
  });

  test('every relayed registration and claim quote carries the top-up flag through to the SDK', () => {
    for (const rel of ['hooks/use-gasless-registration.ts', 'hooks/use-note-import.ts']) {
      const source = read(rel);
      expect(source).toContain('registrationTopUpEnabled(');
      expect(source).toMatch(/extraGas[,:]/);
    }
  });
});

describe('claim top-up scope', () => {
  test('only a register-and-withdraw claim asks the relayer for gas', () => {
    const source = readFileSync(new URL('../../hooks/use-note-import.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /let extraGas = relayed\.mode === 'register-and-withdraw'\s*\n\s*&& registrationTopUpEnabled\(/,
    );
  });
});

describe('banner auto-open guard', () => {
  const banner = read('components/home/finish-setup-banner.tsx');
  const modal = read('components/keystore-registration-modal-provider.tsx');

  test('auto-opens only for an account that arrived partial, and never over an open modal', () => {
    const effect = banner.slice(banner.indexOf('useEffect(() => {'), banner.indexOf('}, [activePartial'));
    expect(effect).toContain('!arrivedPartial');
    expect(effect).toContain('registrationOpen');
    expect(effect.indexOf('takeFinishSetupAutoOpen()')).toBeGreaterThan(effect.indexOf('registrationOpen'));
    expect(banner).toMatch(/activeState !== 'unknown' && firstSeen\.current\?\.key !== identityKey/);
  });

  test('the modal exposes whether it is open, and Finish setup never replaces a pending run', () => {
    expect(modal).toMatch(/isOpen: false,\n\}\);/);
    expect(modal).toMatch(/markRegistered, openFinishSetup, isOpen \}\)/);
    const finish = modal.slice(modal.indexOf('const openFinishSetup = useCallback'));
    const body = finish.slice(0, finish.indexOf('}, ['));
    expect(body).toContain('if (pendingRef.current) return;');
    expect(body.indexOf('if (pendingRef.current) return;')).toBeLessThan(body.indexOf('openKeystoreRegistrationModal(options)'));
  });
});

describe('viewing-key affordability parity', () => {
  const load = () => import('@/services/receive-setup');

  test('the probe and the publish step draw the line at the same wei', async () => {
    const { canAffordViewingKey, decideViewingKeyPath, viewingKeyCostWei } = await load();
    const gasPriceWei = 2_000_000_000n;
    const gasEstimate = 51_000n;
    const cost = viewingKeyCostWei({ gasPriceWei, gasEstimate });
    expect(canAffordViewingKey({ balanceWei: cost, gasPriceWei, gasEstimate })).toBe(true);
    expect(decideViewingKeyPath({ balanceWei: cost, gasPriceWei, gasEstimate }).path).toBe('self-register');
    expect(canAffordViewingKey({ balanceWei: cost - 1n, gasPriceWei, gasEstimate })).toBe(false);
    expect(decideViewingKeyPath({ balanceWei: cost - 1n, gasPriceWei, gasEstimate }).path).toBe('relayed-claim');
  });

  test('a wallet between the real estimate and the static budget is not sold a top-up', async () => {
    const { decideViewingKeyPath, viewingKeyCostWei, VIEWING_KEY_GAS_LIMIT } = await load();
    const gasPriceWei = 2_000_000_000n;
    const real = viewingKeyCostWei({ gasPriceWei, gasEstimate: 51_000n });
    const budget = viewingKeyCostWei({ gasPriceWei, gasEstimate: VIEWING_KEY_GAS_LIMIT });
    const between = (real + budget) / 2n;
    expect(decideViewingKeyPath({ balanceWei: between, gasPriceWei, gasEstimate: 51_000n }))
      .toMatchObject({ path: 'self-register', reason: 'funded' });
    expect(decideViewingKeyPath({ balanceWei: between, gasPriceWei, gasEstimate: null }).path).toBe('relayed-claim');
  });

  test('an empty wallet needs gas, and an unknown gas price stays on the wallet', async () => {
    const { decideViewingKeyPath } = await load();
    expect(decideViewingKeyPath({ balanceWei: 0n })).toMatchObject({ path: 'relayed-claim', reason: 'zero-balance' });
    expect(decideViewingKeyPath({ balanceWei: 1n, gasPriceWei: undefined }))
      .toMatchObject({ path: 'self-register', reason: 'unknown-gas-price' });
  });

  test('both hooks use the shared helper, not their own threshold', () => {
    const probe = read('hooks/use-gasless-registration.ts');
    const publish = read('hooks/use-publish-viewing-key.ts');
    expect(probe).toContain('decideViewingKeyPath(');
    expect(probe).not.toContain('gasLimit: mode === \'top-up\' ? VIEWING_KEY_GAS_LIMIT');
    // DEV-542: the publish step checks the exact planned reserve it sends.
    // DEV-589 review: through walletTxAffordable, so BNB (no fee fields) is still checked.
    expect(publish).toContain('affordable: walletTxAffordable({ plan, balanceWei, chainId })');
    expect(publish).not.toMatch(/cost\.balanceWei < cost\.costWei/);
  });
});

describe('DEV-554: setViewingKey is sent with the gas the app checked', () => {
  test('EIP-1559: the wallet reserves exactly gas x maxFee, the amount every check uses', async () => {
    const { viewingKeyTxPlan, viewingKeyCostWei, canAffordViewingKey } = await import('@/services/receive-setup');
    const gasPriceWei = 1_100_000_000n;
    const plan = viewingKeyTxPlan({ gasEstimate: 51_000n, eip1559: true, priorityFeeWei: 100_000_000n, baseFeeWei: 1_000_000_000n, gasPriceWei });
    expect(plan.gas).toBe(61_200n);
    // DEV-542: maxFee = 2 x base + tip.
    expect(plan.fees).toEqual({ maxFeePerGas: 2_100_000_000n, maxPriorityFeePerGas: 100_000_000n });
    const reserved = plan.gas * (plan.fees as { maxFeePerGas: bigint }).maxFeePerGas;
    expect(plan.costWei).toBe(reserved);
    // The gasPrice-only bound never names less than the wallet reserves.
    expect(viewingKeyCostWei({ gasPriceWei, gasEstimate: 51_000n }) >= reserved).toBe(true);
    // A wallet funded to the named amount passes the check AND the wallet's own reserve.
    const bound = viewingKeyCostWei({ gasPriceWei, gasEstimate: 51_000n });
    expect(canAffordViewingKey({ balanceWei: bound, gasPriceWei, gasEstimate: 51_000n })).toBe(true);
  });

  test('tip is floored and covered by the max fee; legacy chain sends the plain gas price', async () => {
    const { viewingKeyTxPlan, VIEWING_KEY_GAS_LIMIT } = await import('@/services/receive-setup');
    const floored = viewingKeyTxPlan({ gasEstimate: 51_000n, eip1559: true, priorityFeeWei: 1n, baseFeeWei: 1_000n, minPriorityFeeWei: 500n, gasPriceWei: 1_000n });
    expect(floored.fees).toEqual({ maxFeePerGas: 2_500n, maxPriorityFeePerGas: 500n });
    const legacy = viewingKeyTxPlan({ gasEstimate: null, eip1559: false, gasPriceWei: 3_000_000_000n });
    expect(legacy.gas).toBe((VIEWING_KEY_GAS_LIMIT * 12n) / 10n);
    expect(legacy.fees).toEqual({ gasPrice: 3_000_000_000n });
    // The check never names less than the wallet reserves.
    expect(legacy.costWei).toBeGreaterThanOrEqual(legacy.gas * 3_000_000_000n);
  });

  test('an unread block sets no fee fields (wallet prices it), never a legacy tx', async () => {
    const { viewingKeyTxPlan, viewingKeyCostWei } = await import('@/services/receive-setup');
    const plan = viewingKeyTxPlan({ gasEstimate: 51_000n, eip1559: null, gasPriceWei: 2_000_000_000n });
    expect(plan.fees).toBeNull();
    expect(plan.gas).toBe(61_200n);
    expect(plan.costWei).toBe(viewingKeyCostWei({ gasPriceWei: 2_000_000_000n, gasEstimate: 51_000n }));
    const src = readFileSync(new URL('../../hooks/use-publish-viewing-key.ts', import.meta.url), 'utf8');
    expect(src).toContain('readFeeMarket(');
    expect(src).toContain('...(cost.plan.fees ?? {})');
    const shared = readFileSync(new URL('../wallet-tx-fees.ts', import.meta.url), 'utf8');
    expect(shared).toContain('const eip1559 = block === null ? null : baseFeeWei !== null;');
  });

  test('the shown amount is priced on the real setViewingKey calldata the send uses', async () => {
    const { viewingKeyTxPlan, viewingKeyCostWei } = await import('@/services/receive-setup');
    // Same estimate in, same wei out: what the modal shows is what publish checks and sends.
    const gasPriceWei = 1_300_000_000n;
    const plan = viewingKeyTxPlan({ gasEstimate: 49_871n, eip1559: true, priorityFeeWei: 1n, baseFeeWei: 1_200_000_000n, gasPriceWei });
    const fees = plan.fees as { maxFeePerGas: bigint };
    expect(plan.costWei).toBe(plan.gas * fees.maxFeePerGas);
    expect(viewingKeyCostWei({ gasPriceWei, gasEstimate: 49_871n }) >= plan.costWei).toBe(true);
    const hook = readFileSync(new URL('../../hooks/use-publish-viewing-key.ts', import.meta.url), 'utf8');
    expect(hook).toContain('return await estimateCost(registration.viewingKeyCalldata);');
    const modal = readFileSync(new URL('../../components/keystore-registration-modal-provider.tsx', import.meta.url), 'utf8');
    expect(modal).toContain('void estimatePublishCost().then(');
    expect(modal).not.toContain('estimateCost()');
  });

  test('the publish hook sends the planned gas and fees, and the copy names the amount', async () => {
    const src = readFileSync(new URL('../../hooks/use-publish-viewing-key.ts', import.meta.url), 'utf8');
    expect(src).toContain('gas: cost.plan.gas, ...(cost.plan.fees ?? {})');
    const { describeFinishSetupGas } = await import('@/services/receive-setup');
    const copy = describeFinishSetupGas({ estimate: '0.00003 ETH', chainName: 'Ethereum' });
    expect(copy).toBe('This wallet needs about 0.00003 ETH on Ethereum to pay the gas.');
    expect(copy).not.toContain('—');
  });
});

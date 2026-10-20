// Isolated prod process, spawned and count-pinned by environments.test.ts.
import { describe, expect, mock, test } from 'bun:test';

const prod = process.env.EXPO_PUBLIC_APP_ENV === 'prod';
if (prod) mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));

// The app's local bun:test declarations omit describe.skip.
const describeProd = prod ? describe : (_name: string, _fn: () => void) => {};
describeProd('prod intent landing capabilities', () => {
  // The surface is UNLOCKED by default. The harness still passes an explicit
  // `false` so this file's meaning does not depend on the default holding: the
  // capability rules below describe what is offered once unlocked, and an
  // unlocked build must not meet them for the first time in production.
  test('this run is unlocked, so the capability matrix below applies', async () => {
    const { INTENT_LOCKDOWN } = await import('@/config/intent-lockdown');
    expect(INTENT_LOCKDOWN).toBe(false);
  });

  test('a conversion may land in a mainnet vault; a wallet delivery never can', async () => {
    // Two lists, two questions. getSwapOutputTokens answers where a CONVERSION
    // can land, so the mainnet shares belong there: LiFi is asked for the plain
    // underlying and the PPRouter mints the share. getSwapDeliveryTokens
    // answers what LiFi can pay to an ADDRESS, which no share can be.
    const swaps = await import('@/config/intent-swaps');
    expect(swaps.getSwapOutputTokens(1).map((t) => t.symbol)).toEqual(['ppUSDC', 'ppUSDT', 'ppETH']);
    expect(swaps.getSwapOutputTokens(56).map((t) => t.symbol)).toEqual(['BNB', 'FDUSD', 'U', 'ppUSDT']);
    // Naming a source chain makes this the SHIELDED cross-chain swap (the
    // reshield). Its destination leg funds a share through that chain's router,
    // via buildRedeposit, so the shares are reachable from the other side. BNB
    // is not: the bridge executes the deposit and cannot send the exact
    // msg.value a plain native Entrypoint deposit needs (v2-monorepo#437).
    expect(swaps.getSwapOutputTokens(1, 56).map((t) => t.symbol)).toEqual(['ppUSDC', 'ppUSDT', 'ppETH']);
    expect(swaps.getSwapOutputTokens(56, 1).map((t) => t.symbol)).toEqual(['FDUSD', 'U', 'ppUSDT']);
    // Delivery: plain assets only, on either chain, from anywhere. The
    // entrypoint's enabled set is not the answer here, so the registry's plain
    // assets are included too. Mainnet used to read ['ETH'] alone, which meant
    // the "Receive as" picker offered one thing on the chain with the most
    // liquidity; the superseded stables are still perfectly deliverable
    // (Mike, 2026-09-22). Shares remain absent on both chains, which is the
    // property this line is really guarding.
    expect(swaps.getSwapDeliveryTokens(1).map((t) => t.symbol)).toEqual(['ETH', 'USDC', 'USDT']);
    expect(swaps.getSwapDeliveryTokens(56).map((t) => t.symbol)).toEqual(['BNB', 'FDUSD', 'U', 'USDT']);
    // Every share address comes from the live yield table, never a literal.
    const { PROD_YIELD_DEPLOYMENTS } = await import('@/config/prod-deployments');
    for (const chain of [1, 56]) {
      const configured = PROD_YIELD_DEPLOYMENTS[chain].map((d) => d.ppUSDC.toLowerCase());
      const { ACTIVE_ENVIRONMENT } = await import('@/config/environments');
      for (const token of swaps.getSwapOutputTokens(chain)) {
        const meta = ACTIVE_ENVIRONMENT.tokensByChain[chain][token.address.toLowerCase()];
        expect(meta).toBeDefined();
        expect(meta.decimals).toBe(token.decimals);
        if (meta.yieldShare) expect(configured).toContain(token.address.toLowerCase());
      }
    }
    // The destination-chain picker follows: mainnet is a destination from
    // mainnet again (it was dropped entirely while its list was empty), and a
    // mainnet note can still be delivered to BNB Chain.
    expect(swaps.getSwapDestinationChains(1)).toEqual([1, 56, 10, 8453, 42161, 4663]);
    expect(swaps.getSwapDestinationChains(56)).toEqual([56, 1, 10, 8453, 42161, 4663]);
    // A share is a source as well as a target. Nothing sells the share itself:
    // RelaySwaps redeems it to the underlying and LiFi is quoted from that. The
    // list was ['ETH'] alone until 2026-09-22, which after the ppETH launch left
    // every note a new user held unable to start a swap.
    //
    // And legacy ETH is NOT here: a plain pool a share replaced is withdrawable
    // and sendable, never swappable (Pat, 2026-09-22). So mainnet's sources are
    // the three shares, and the list has gone from only-legacy to no-legacy.
    expect(swaps.getSwapInputTokens(1).map((t) => t.symbol)).toEqual(['ppUSDC', 'ppUSDT', 'ppETH']);
    expect(swaps.getSwapInputTokens(56).map((t) => t.symbol)).toEqual(['BNB', 'FDUSD', 'U', 'ppUSDT']);
    for (const chain of [4114, 11155111, 999]) expect(swaps.getSwapOutputTokens(chain)).toEqual([]);
    // OP now swaps (2026-10-15): conversions land in its share pools, like mainnet.
    expect(swaps.getSwapOutputTokens(10).map((t) => t.symbol)).toEqual(["ppUSDC", "ppUSDT", "ppETH"]);
    for (const chain of [4114, 11155111, 999]) expect(swaps.getSwapDeliveryTokens(chain)).toEqual([]);
    // OP is a LiFi chain on prod since 2026-10-14: a wallet there can be paid
    // its plain assets, never a share.
    expect(swaps.getSwapDeliveryTokens(10).map((t) => t.symbol)).toEqual(['ETH', 'USDC', 'USDT']);
  });

  test('a bridged deposit never lands where the bridge cannot call (destinationCallsSupported)', async () => {
    const swaps = await import('@/config/intent-swaps');
    const dc = await import('@/config/destination-calls');
    dc.resetRelayerDestinationCallsForTests();
    try {
      // Static fallback: Citrea and Robinhood have no LI.FI receivers yet.
      for (const chain of [4114, 4663]) {
        expect(dc.destinationCallsSupported(chain)).toBe(false);
        for (const source of [1, 56]) {
          expect(swaps.crossChainReshieldSupported(source, chain)).toBe(false);
          expect(swaps.crossChainSwapDepositSupported(source, chain)).toBe(false);
        }
      }
      for (const chain of [1, 56, 10, 8453, 42161]) expect(dc.destinationCallsSupported(chain)).toBe(true);
      // A withdraw that pays a public wallet on Robinhood needs no destination call.
      expect(swaps.getSwapDestinationChains(1)).toContain(4663);
      expect(swaps.getSwapDeliveryTokens(4663).length).toBeGreaterThan(0);
      // The relayer's explicit answer wins over the table, both ways.
      dc.recordRelayerDestinationCalls(56, false);
      expect(swaps.crossChainReshieldSupported(1, 56)).toBe(false);
      expect(swaps.crossChainSwapDepositSupported(1, 56)).toBe(false);
      dc.recordRelayerDestinationCalls(56, undefined);
      expect(swaps.crossChainReshieldSupported(1, 56)).toBe(true);
      dc.recordRelayerDestinationCalls(4663, true);
      expect(dc.destinationCallsSupported(4663)).toBe(true);
    } finally {
      dc.resetRelayerDestinationCallsForTests();
    }
  });

  test('same-chain and bridge/reshield matrices land only in BNB open pools', async () => {
    const swaps = await import('@/config/intent-swaps');
    // Mainnet conversions land in the share pools through their router, so
    // flow 1 is available there even though the swap DELIVERY list is empty.
    expect(swaps.swapDepositEnabledForChain(1)).toBe(true);
    expect(swaps.swapDepositEnabledForChain(56)).toBe(true);
    expect(swaps.crossChainSwapDepositSupported(1, 56)).toBe(true);
    // Was false until 2026-09-22, on the reasoning that a share pool needs a
    // destination router this flow does not carry. It does carry one: the
    // session is built for the POOL chain with its yield deployments and the
    // wallet's chain attached as swapDepositSourceChain, and the SDK sizes a
    // share target through that router whichever chain the input token is on
    // (PoolSessionSwapDeposit.prepareSwapAndDeposit). Every mainnet pool is a
    // share, so this one assertion is the whole "pay on BNB, shield on mainnet"
    // question (Mike, QA).
    expect(swaps.crossChainSwapDepositSupported(56, 1)).toBe(true);
    expect(swaps.crossChainReshieldSupported(1, 56)).toBe(true);
    // True since the destination leg can fund a share: mainnet's pools are all
    // shares, so this direction had no reachable target before and therefore no
    // route. "BNB to mainnet needs router support for bridged conversions into
    // vaults, our side not theirs" (Pat) — this is that support.
    expect(swaps.crossChainReshieldSupported(56, 1)).toBe(true);
    expect(swaps.intentSwapsEnabledForChain(1)).toBe(true);
    expect(swaps.intentSwapsEnabledForChain(56)).toBe(true);
    // 2026-10-15: the relayer serves swaps on OP, Base and Arbitrum with the
    // mainnet RelaySwaps, so notes swap and reshield from there like mainnet.
    for (const chain of [10, 8453, 42161]) {
      expect(swaps.intentSwapsEnabledForChain(chain)).toBe(true);
      expect(swaps.crossChainReshieldSupported(chain, 56)).toBe(true);
      expect(swaps.crossChainReshieldSupported(1, chain)).toBe(true);
      expect(swaps.swapChainUnavailableReason(chain, 'source')).toBeUndefined();
      expect(swaps.swapChainUnavailableReason(chain, 'destination', 1)).toBeUndefined();
      expect(swaps.swapDepositEnabledForChain(chain)).toBe(true);
    }
    // Robinhood: no RelaySwaps and no LI.FI receiver, so it is greyed out with
    // a reason. A wallet-funded swap deposit INTO it needs neither.
    expect(swaps.intentSwapsEnabledForChain(4663)).toBe(false);
    expect(swaps.crossChainReshieldSupported(4663, 56)).toBe(false);
    expect(swaps.swapChainUnavailableReason(4663, 'source')).toBe('No swaps yet');
    expect(swaps.swapChainUnavailableReason(4663, 'destination', 1)).toBe('Swaps cannot land here yet');
    expect(swaps.swapDepositEnabledForChain(4663)).toBe(true);
    // Staging BNB's RelaySwaps must never become prod's processor.
    expect(swaps.getSwapProcessorAddress(56)?.toLowerCase()).toBe('0xd0395c08dd8ea7671a7a65bdca8e473e8e8260a8');
    // History recognizes staging callers even when the active processor is prod.
    // This cannot pass through isSwapRouteCaller's active-address fallback.
    expect(swaps.isSwapRouteCaller('0xbe16948700c538D71599dB99Df604a2EA9a7e61a', 56)).toBe(true);
    expect(swaps.isSwapRouteCaller('0xbe16948700c538D71599dB99Df604a2EA9a7e61a', 10)).toBe(false);
    for (const chain of [4114, 11155111, 999]) {
      expect(swaps.intentSwapsEnabledForChain(chain)).toBe(false);
      expect(swaps.swapDepositEnabledForChain(chain)).toBe(false);
      expect(swaps.crossChainSwapDepositSupported(chain, 56)).toBe(false);
      expect(swaps.crossChainReshieldSupported(chain, 56)).toBe(false);
    }
  });

  test('configured supersession and native/yield routes agree before any vault probe', async () => {
    const { ACTIVE_ENVIRONMENT, NATIVE_ASSET_ADDRESS } = await import('@/config/environments');
    const { isSupersededLegacyPool } = await import('@/config/pool-paths');
    const { conversionDepositTarget, intentTargetRefusal, isConfiguredShareTarget, targetAcceptsConversion } = await import('@/config/intent-targets');
    expect(isSupersededLegacyPool('ETH', 1)).toBe(true);
    for (const token of Object.values(ACTIVE_ENVIRONMENT.tokensByChain[1])) {
      // A configured share is a valid destination now: the conversion ends in
      // its router. Everything else on mainnet is closed, superseded, or an
      // underlying whose own Entrypoint deposit is shut.
      const expected = !!token.yieldShare;
      expect(isConfiguredShareTarget(token.address, 1)).toBe(expected);
      expect(isConfiguredShareTarget(token.address.toUpperCase(), 1)).toBe(expected);
      expect(targetAcceptsConversion(token, 1, isSupersededLegacyPool(token.symbol, 1))).toBe(expected);
      // The bridged leg is no longer restricted to the Entrypoint, so a share
      // is accepted there on the same terms as anywhere else: its router.
      expect(targetAcceptsConversion(token, 1, isSupersededLegacyPool(token.symbol, 1), true)).toBe(expected);
      expect(intentTargetRefusal(token.address, 1) ?? '').not.toMatch(/ppETH|ppUSDC|ppUSDT|WETH|—/);
    }
    expect(intentTargetRefusal(NATIVE_ASSET_ADDRESS, 1)).toContain('Shield ETH directly instead.');
    // The coin is refused; the pool it actually enters is not.
    expect(intentTargetRefusal(conversionDepositTarget(NATIVE_ASSET_ADDRESS, 1, true), 1)).toBeNull();
    expect(intentTargetRefusal(NATIVE_ASSET_ADDRESS, 56)).toBeNull();
    expect(intentTargetRefusal(NATIVE_ASSET_ADDRESS, 10)).not.toBeNull();
    for (const [address, chain] of [[`0x${'0'.repeat(40)}`, 1], [NATIVE_ASSET_ADDRESS, 999]] as const) {
      expect(isConfiguredShareTarget(address, chain)).toBe(false);
      expect(intentTargetRefusal(address, chain)).not.toBeNull();
    }
  });

  test('a configured share is a swap SOURCE but never a wallet delivery', async () => {
    const { ACTIVE_ENVIRONMENT, NATIVE_ASSET_ADDRESS } = await import('@/config/environments');
    const swaps = await import('@/config/intent-swaps');
    const { getConfiguredYieldDeployments } = await import('@/config/yield');
    for (const chain of [1, 56]) {
      const configured = new Set(getConfiguredYieldDeployments(chain).map((d) => d.ppUSDC.toLowerCase()));
      const deliverable = new Set(swaps.getSwapDeliveryTokens(chain).map((t) => t.address.toLowerCase()));
      for (const token of Object.values(ACTIVE_ENVIRONMENT.tokensByChain[chain])) {
        if (!token.yieldShare) continue;
        // Spendable as a source exactly when this build configures its wrapper,
        // because that wrapper is what the redemption resolves through.
        expect(swaps.intentSwapInputSupported(chain, token.address))
          .toBe(configured.has(token.address.toLowerCase()));
        // The delivery list is the one the 2026-09-04 liquidity constraint
        // really governs: LiFi would have to hand the share to an address.
        expect(deliverable.has(token.address.toLowerCase())).toBe(false);
      }
    }
    // Legacy ETH is no longer a swap source at all, which is the point of the
    // 2026-09-22 change: it stays reachable through Withdraw and Send.
    expect(swaps.intentSwapInputSupported(1, NATIVE_ASSET_ADDRESS)).toBe(false);
    // BNB is NOT superseded on its chain, so a plain native source still works
    // where no share has replaced it.
    expect(swaps.intentSwapInputSupported(56, NATIVE_ASSET_ADDRESS)).toBe(true);
  });

  test('the swap leg is denominated in what a share redeems to, not in the share', async () => {
    const { swapInputUnits } = await import('@/config/intent-swaps');
    const { getConfiguredYieldDeployments } = await import('@/config/yield');
    const noteUnits = { symbol: 'ppUSDC', decimals: 18 };
    for (const deployment of getConfiguredYieldDeployments(1)) {
      expect(swapInputUnits(1, deployment.ppUSDC, noteUnits))
        .toEqual({ symbol: deployment.underlyingSymbol, decimals: deployment.underlyingDecimals });
    }
    // ppUSDC is 18 decimals over 6-decimals USDC, so reading the net through
    // the note's own units would render a trillionth of it as a tidy "0.00".
    const usdc = getConfiguredYieldDeployments(1).find((d) => d.underlyingSymbol === 'USDC');
    expect(usdc?.underlyingDecimals).toBe(6);
    // A plain note keeps its own identity: nothing is redeemed.
    const plain = { symbol: 'ETH', decimals: 18 };
    const { NATIVE_ASSET_ADDRESS } = await import('@/config/environments');
    expect(swapInputUnits(1, NATIVE_ASSET_ADDRESS, plain)).toEqual(plain);
  });

  test('all builders refuse mainnet targets before touching SDK, quote or wallet', async () => {
    const { ACTIVE_ENVIRONMENT, NATIVE_ASSET_ADDRESS } = await import('@/config/environments');
    const flows = await import('@/services/swap-flows');
    let touched = false;
    const unexpected = () => { touched = true; throw new Error('SDK must not be reached'); };
    const session = new Proxy({}, { get: () => unexpected });
    // Share targets are reachable now and would run into the proxy; they are
    // covered by the capability assertions above and the router-leg tests.
    for (const token of Object.values(ACTIVE_ENVIRONMENT.tokensByChain[1]).filter((t) => !t.yieldShare)) {
      const outputToken = token.address as `0x${string}`;
      const common = { chainId: 1, relayerInfo: {}, grossWei: 1n, inputToken: NATIVE_ASSET_ADDRESS as `0x${string}`, outputToken };
      await expect(flows.runSwapAndDeposit(session as Parameters<typeof flows.runSwapAndDeposit>[0], {
        fromChainId: 56, depositChainId: 1, inputToken: NATIVE_ASSET_ADDRESS as `0x${string}`,
        depositToken: outputToken, depositAmountWei: 1n, allowSameToken: true, submit: unexpected,
      })).rejects.toThrow(/conversion|deposits/);
      await expect(flows.estimateReshieldForReview(session as Parameters<typeof flows.estimateReshieldForReview>[0], {
        ...common, input: { symbol: 'ETH', decimals: 18 }, output: { symbol: token.symbol, decimals: token.decimals },
      })).rejects.toThrow(/conversion|deposits/);
      await expect(flows.runReshield(session as Parameters<typeof flows.runReshield>[0], {
        ...common, inputCommitments: [],
      })).rejects.toThrow(/conversion|deposits/);
      await expect(flows.runReshieldCrosschain(
        session as Parameters<typeof flows.runReshieldCrosschain>[0],
        session as Parameters<typeof flows.runReshieldCrosschain>[1],
        { ...common, toChainId: 1, fallbackAddress: NATIVE_ASSET_ADDRESS as `0x${string}`, inputCommitments: [] },
      )).rejects.toThrow(/conversion|deposits/);
    }
    expect(touched).toBe(false);
  });
  test('a conversion targets the share, is funded with the underlying, and says so per chain', async () => {
    const { ACTIVE_ENVIRONMENT, NATIVE_ASSET_ADDRESS } = await import('@/config/environments');
    const {
      conversionDepositTarget,
      conversionFundingToken,
      conversionTargetsFor,
      intentTargetRefusal,
    } = await import('@/config/intent-targets');
    const shares = Object.values(ACTIVE_ENVIRONMENT.tokensByChain[1]).filter((t) => t.yieldShare);
    expect(shares.map((t) => t.symbol).sort()).toEqual(['ppETH', 'ppUSDC', 'ppUSDT']);

    // The coin and the underlying both route into their share pool.
    expect(conversionDepositTarget(NATIVE_ASSET_ADDRESS, 1, true).toLowerCase())
      .toBe(shares.find((t) => t.symbol === 'ppETH')!.address.toLowerCase());
    for (const share of shares) {
      // A share funds itself with what a DEX can actually deliver.
      const funding = conversionFundingToken(share.address, 1).toLowerCase();
      expect(funding).not.toBe(share.address.toLowerCase());
      if (share.symbol === 'ppETH') expect(funding).toBe(NATIVE_ASSET_ADDRESS.toLowerCase());
      // A conversion lands either way now: the bridged leg funds the share
      // through its router, so the transport stopped being a reason to refuse.
      expect(intentTargetRefusal(share.address, 1)).toBeNull();
      expect(intentTargetRefusal(share.address, 1, false, true)).toBeNull();
      // Supersession still refuses a share even with its router configured.
      // Assert the refusal exists before checking its display names.
      const superseded = intentTargetRefusal(share.address, 1, true, true);
      expect(superseded).toContain('Shield ');
      expect(superseded).not.toMatch(/ppETH|ppUSDC|ppUSDT|WETH|—/);
    }

    // Exactly the three share pools, and nothing plain, can receive a conversion.
    expect(conversionTargetsFor(1).sort()).toEqual(shares.map((t) => t.address.toLowerCase()).sort());
    // BSC keeps its open plain pools and gains its share pool.
    expect(conversionTargetsFor(56).length).toBeGreaterThan(1);
    // A bridged deposit reaches the mainnet share pools now, through their
    // routers, so it sees exactly what the same-chain flow sees. A closed plain
    // pool is still closed either way; that is the yield rule, not the
    // transport.
    expect(conversionTargetsFor(1, true)).toEqual(conversionTargetsFor(1));
    // Citrea has an open native pool but no native swap executor, so a swap
    // cannot deposit the native coin there and it answers with none.
    expect(conversionTargetsFor(4114).length).toBe(0);
    const swaps2 = await import('@/config/intent-swaps');
    expect(swaps2.swapDepositEnabledForChain(4114)).toBe(false);
    for (const chain of [11155111, 999]) expect(conversionTargetsFor(chain)).toEqual([]);
  });

  test('a wallet on BNB Chain can shield into a mainnet vault, and only that changed', async () => {
    // "Pay on BNB, shield on mainnet" (Mike, QA). Every mainnet pool is a share
    // now, so the whole route turns on a share being a valid destination for a
    // deposit whose input token lives elsewhere. It is, because the deposit is
    // prepared on a session built for MAINNET, carrying mainnet's yield
    // deployments, with BNB Chain attached only as the swap source.
    const swaps = await import('@/config/intent-swaps');
    const { ACTIVE_ENVIRONMENT, NATIVE_ASSET_ADDRESS } = await import('@/config/environments');
    const {
      assertIntentDepositTarget,
      conversionDepositTarget,
      conversionTargetsFor,
    } = await import('@/config/intent-targets');
    expect(swaps.crossChainSwapDepositSupported(56, 1)).toBe(true);
    // The destination list the cross-chain shield reads is the same-chain one:
    // arriving from elsewhere subtracts nothing. That is now true of the bridged
    // reshield too, since its far leg funds a share through the router rather
    // than calling the Entrypoint, so the two lists agree.
    expect(conversionTargetsFor(1, true)).toEqual(conversionTargetsFor(1));
    const targets = conversionTargetsFor(1);
    const shares = Object.values(ACTIVE_ENVIRONMENT.tokensByChain[1]).filter((t) => t.yieldShare);
    expect(targets.sort()).toEqual(shares.map((t) => t.address.toLowerCase()).sort());
    // What the deposit modal computes for a bridged shield: the asset picked on
    // mainnet resolves to its share, and the share is accepted.
    for (const token of Object.values(ACTIVE_ENVIRONMENT.tokensByChain[1])) {
      const target = conversionDepositTarget(token.address, 1, token.isNative);
      if (!targets.includes(target.toLowerCase())) continue;
      expect(() => assertIntentDepositTarget(target, 1)).not.toThrow();
      // The reshield's far leg accepts it too now: same router, same check.
      expect(() => assertIntentDepositTarget(target, 1, true)).not.toThrow();
    }
    expect(conversionDepositTarget(NATIVE_ASSET_ADDRESS, 1, true).toLowerCase())
      .toBe(shares.find((t) => t.symbol === 'ppETH')!.address.toLowerCase());

    // Plain bridge destinations keep exactly the token id the previous path
    // passed to the SDK; only a configured vault changes the final target.
    for (const token of swaps.getSwapOutputTokens(56, 1)) {
      const tokenId = token.address.toLowerCase();
      expect(conversionDepositTarget(tokenId, 56, tokenId === NATIVE_ASSET_ADDRESS.toLowerCase()))
        .toBe(tokenId);
    }

    // Exercise the public builders as well as the rules. A direct caller whose
    // destination session cannot fund the share must still stop before any
    // estimate or proof: config knowing the router exists is not the same as
    // this session carrying that chain's yield targets.
    const flows = await import('@/services/swap-flows');
    const reached: string[] = [];
    const unexpected = async () => { reached.push('SDK'); throw new Error('SDK must not be reached'); };
    for (const chain of [1, 56]) {
      for (const share of Object.values(ACTIVE_ENVIRONMENT.tokensByChain[chain]).filter((t) => t.yieldShare)) {
        const outputToken = share.address as `0x${string}`;
        const source = {
          estimateReshieldCrosschainAmount: unexpected,
          prepareReshieldCrosschainQuote: unexpected,
          relayReshieldCrosschain: unexpected,
        };
        const params = {
          relayerInfo: {}, grossWei: 1n, inputToken: NATIVE_ASSET_ADDRESS as `0x${string}`,
          outputToken, toChainId: chain, fallbackAddress: NATIVE_ASSET_ADDRESS as `0x${string}`,
          inputCommitments: ['0x01' as const],
        };
        for (const capability of [
          {},
          { yieldFor: () => undefined },
          { yieldFor: () => ({ deployment: { ppUSDC: NATIVE_ASSET_ADDRESS } }) },
        ]) {
          await expect(flows.runReshieldCrosschain(source, { prepareDeposit: unexpected, ...capability }, params))
            .rejects.toThrow(/cannot deposit into that vault/);
          expect(reached).toEqual([]);
        }

        // A capability accepted before the estimate must still be required at
        // proving. A missing namespace must never choose the plain deposit.
        const estimate = {
          feeAmount: '0', netSwapAmount: '1', estimatedOutput: '100', estimatedMinOutput: '100',
          noteValue: '0x2' as const, vettingFee: '0', totalDepositCost: '100',
        };
        for (const laterTarget of [undefined, { deployment: { ppUSDC: NATIVE_ASSET_ADDRESS } }]) {
          const calls: string[] = [];
          let estimated = false;
          await expect(flows.runReshieldCrosschain({
            ...source,
            estimateReshieldCrosschainAmount: async () => {
              calls.push('estimate');
              estimated = true;
              return estimate;
            },
          }, {
            prepareDeposit: unexpected,
            yieldFor: () => {
              calls.push('yieldFor');
              return estimated ? laterTarget : { deployment: { ppUSDC: outputToken.toUpperCase() } };
            },
          }, params)).rejects.toThrow(/cannot deposit into that vault/);
          expect(calls).toEqual(['yieldFor', 'estimate', 'yieldFor']);
          expect(reached).toEqual([]);
        }

        // Exercise the real SDK router builder with local deposit methods.
        // The budget and bridge rate reserve must survive into the proof.
        const { CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM } = await import('@privacy-pools-v2/sdk');
        const calls: unknown[] = [];
        const pendingNote = { isOwned: true, commitment: '0x02' as const, value: '0x2' as const };
        const target = {
          chainId: chain,
          deployment: { ppUSDC: outputToken.toUpperCase() },
          deposit: {
            sizeSharesForBudget: async (budget: bigint, headroom: bigint) => {
              calls.push({ budget, headroom });
              return { shares: 2n, maxUnderlyingIn: budget };
            },
            prepareYieldDeposit: async (depositParams: unknown) => {
              calls.push(depositParams);
              return { pendingNote, depositTx: { to: outputToken, data: '0x12', value: '0x0' } };
            },
          },
        };
        await expect(flows.runReshieldCrosschain({
          ...source,
          estimateReshieldCrosschainAmount: async () => { calls.push('estimate'); return estimate; },
          prepareReshieldCrosschainQuote: async (quoteParams) => {
            calls.push(quoteParams.depositResult);
            throw new Error('Reached router quote');
          },
        }, {
          prepareDeposit: unexpected,
          yieldFor: () => { calls.push('yieldFor'); return target; },
        }, params)).rejects.toThrow('Reached router quote');
        expect(calls).toEqual([
          'yieldFor', 'estimate', 'yieldFor',
          { budget: 100n, headroom: CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM },
          { value: 2n, maxUnderlyingIn: 100n, fundingSource: 'executor' },
          { pendingNote, depositTx: { to: outputToken, data: '0x12', value: '0x0' }, approvalTxs: [], approvalTx: null },
        ]);
        expect(reached).toEqual([]);

        const prepared: unknown[] = [];
        await expect(flows.runSwapAndDeposit({
          prepareSwapAndDeposit: async (params) => {
            prepared.push(params);
            throw new Error('Reached destination swap-deposit session');
          },
        }, {
          fromChainId: chain === 1 ? 56 : 1, depositChainId: chain,
          inputToken: NATIVE_ASSET_ADDRESS as `0x${string}`, depositToken: outputToken,
          depositAmountWei: 1n, submit: unexpected,
        })).rejects.toThrow('Reached destination swap-deposit session');
        expect(prepared).toEqual([{
          fromChainId: chain === 1 ? 56 : 1, inputToken: NATIVE_ASSET_ADDRESS,
          depositToken: outputToken, depositAmount: '0x1',
        }]);
        expect(reached).toEqual([]);
      }
    }

    // Untouched by this: LiFi still cannot pay a share out to an ADDRESS. What
    // changed is the shielded route, which deposits rather than pays out.
    for (const chain of [1, 56]) {
      for (const token of swaps.getSwapDeliveryTokens(chain)) {
        expect(ACTIVE_ENVIRONMENT.tokensByChain[chain][token.address.toLowerCase()]?.yieldShare).toBeUndefined();
      }
    }
    // The shielded cross-chain swap reaches the shares in both directions, and
    // never the plain native coin.
    expect(swaps.getSwapOutputTokens(1, 56).map((t) => t.symbol)).toEqual(['ppUSDC', 'ppUSDT', 'ppETH']);
    expect(swaps.getSwapOutputTokens(56, 1).map((t) => t.symbol)).toEqual(['FDUSD', 'U', 'ppUSDT']);
  });

  // DEV-509 follow-up: a cross-chain swap-send to someone else runs the SDK's
  // reshield-and-transfer-crosschain. Only a yield share on the destination is
  // served; the note is the recipient's, so nothing of it comes back here.
  test('a cross-chain swap-send deposits a share FOR the recipient and keeps no note', async () => {
    const { ACTIVE_ENVIRONMENT, NATIVE_ASSET_ADDRESS } = await import('@/config/environments');
    const flows = await import('@/services/swap-flows');
    const RECIPIENT = '0x6666666666666666666666666666666666666666' as const;
    const FALLBACK = '0x7777777777777777777777777777777777777777' as const;
    const share = Object.values(ACTIVE_ENVIRONMENT.tokensByChain[56]).find((t) => t.yieldShare)!;
    const plain = Object.values(ACTIVE_ENVIRONMENT.tokensByChain[56]).find((t) => t.symbol === 'FDUSD')!;
    expect(share.symbol).toBe('ppUSDT');
    expect(flows.crossChainSendOutputSupported(share.address, 56)).toBe(true);
    expect(flows.crossChainSendOutputSupported(plain.address, 56)).toBe(false);
    expect(flows.crossChainSendOutputSupported(NATIVE_ASSET_ADDRESS, 56)).toBe(false);

    const gross = 1_010_000n;
    const estimate = {
      feeAmount: '0x2710', netSwapAmount: '0xf4240', estimatedOutput: '0xf3e58', estimatedMinOutput: '0xf1b30',
      noteValue: '0xf3e58' as const, vettingFee: '0', totalDepositCost: '1000000',
    };
    const quote = {
      selectedQuote: { quote: { feeCommitment: { amountSent: `0x${gross.toString(16)}` }, feeAmount: '0x2710' } },
      swapCalldata: '0xcafe' as const, feeAmount: '0x2710', netAmount: '0xf4240' as const,
    };
    const own = async () => { throw new Error('the own-note calls must not run for a swap-send'); };
    const make = (owned = false) => {
      const order: string[] = [];
      const calls: Record<string, any> = {};
      const source = {
        estimateReshieldCrosschainAmount: own, prepareReshieldCrosschainQuote: own, relayReshieldCrosschain: own,
        estimateReshieldTransferCrosschainAmount: async (p: unknown) => { order.push('estimate'); calls.estimate = p; return estimate; },
        prepareReshieldTransferCrosschainDeposit: async (p: unknown) => {
          order.push('deposit'); calls.deposit = p;
          return { pendingNote: { isOwned: owned, commitment: '0x01' as const, value: '0x1' as const } };
        },
        prepareReshieldTransferCrosschainQuote: async (p: unknown) => { order.push('quote'); calls.quote = p; return quote; },
        relayReshieldTransferCrosschain: async (p: unknown) => { order.push('relay'); calls.relay = p; return { txHash: '0xabc' as const, status: true }; },
      };
      return { source, order, calls };
    };
    const destination = { prepareDeposit: own };
    const params = (outputToken: string) => ({
      relayerInfo: {}, grossWei: gross, inputToken: NATIVE_ASSET_ADDRESS as `0x${string}`,
      outputToken: outputToken as `0x${string}`, toChainId: 56, fallbackAddress: FALLBACK,
      inputCommitments: ['0x02' as const], recipient: { discoveryData: { evmAddress: RECIPIENT } },
    });

    const ok = make();
    const result = await flows.runReshieldCrosschain(ok.source as any, destination as any, params(share.address));
    expect(ok.order).toEqual(['estimate', 'deposit', 'quote', 'relay']);
    expect(ok.calls.estimate.fallbackAddress).toBe(FALLBACK);
    expect(ok.calls.deposit).toEqual({
      discoveryData: { evmAddress: RECIPIENT }, outputToken: share.address, totalDepositCost: '1000000',
    });
    expect(ok.calls.relay.amount).toBe(quote.netAmount);
    expect('depositNote' in ok.calls.relay).toBe(false);
    expect(result.pendingNote).toBeUndefined();

    // A plain output across chains has no private route: refused before the SDK.
    const plainRun = make();
    await expect(flows.runReshieldCrosschain(plainRun.source as any, destination as any, params(plain.address)))
      .rejects.toThrow(/cannot be sent privately/);
    expect(plainRun.order).toEqual([]);

    // A build without the transfer calls refuses instead of a self reshield.
    const bare = { estimateReshieldCrosschainAmount: own, prepareReshieldCrosschainQuote: own, relayReshieldCrosschain: own };
    await expect(flows.runReshieldCrosschain(bare as any, destination as any, params(share.address)))
      .rejects.toThrow(/not available yet/);

    // A real PoolSession always has the methods and throws when the delegate is
    // missing (no destination share targets). That reads as "not available".
    const unconfigured = async () => { throw new Error('ReshieldTransferCrosschain is not available. Provide destinationChainId, destinationEntrypointInteractor, and destinationYieldDepositTargets in PoolSessionConfig.'); };
    const missing = { ...bare, estimateReshieldTransferCrosschainAmount: unconfigured, prepareReshieldTransferCrosschainDeposit: unconfigured, prepareReshieldTransferCrosschainQuote: unconfigured, relayReshieldTransferCrosschain: unconfigured };
    await expect(flows.runReshieldCrosschain(missing as any, destination as any, params(share.address)))
      .rejects.toThrow(/not available yet/);

    // A deposit built for this account never reaches the quote or the relayer.
    const selfOwned = make(true);
    await expect(flows.runReshieldCrosschain(selfOwned.source as any, destination as any, params(share.address)))
      .rejects.toThrow(/not the recipient/);
    expect(selfOwned.order).toEqual(['estimate', 'deposit']);
  });
});

/**
 * LiFi's Across adapter refuses a cross-chain contract call that delivers the
 * native coin ("[Across] Destination token can not be sent to receiver address
 * 0xe417AD5e...", code 1011), and LiFi answers with that error instead of
 * trying another bridge. That is every wallet-funded shield into a native-mode
 * share (ppETH) from another network: the router call takes `msg.value`, so the
 * route must deliver ETH, not WETH.
 *
 * Probed 2026-10-19, Base -> OP, 0.005 and 0.05 ETH, target the OP ppETH router:
 * native delivery fails as above, the same body with `denyBridges: ['across']`
 * quotes via stargateV2. `allowBridges` is not honoured on /quote/contractCalls,
 * so the deny list is the only lever. Every other bridge stays in play, and an
 * ERC-20 delivery keeps Across.
 */
export const LIFI_NATIVE_DELIVERY_DENIED_BRIDGES: readonly string[] = ['across'];

const NATIVE_FORMS = new Set([
  '0x0000000000000000000000000000000000000000',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
]);

export function isLifiNativeToken(token: string | undefined | null): boolean {
  return !!token && NATIVE_FORMS.has(token.toLowerCase());
}

/** Bridges to deny for one contract-call quote, or undefined for none. */
export function contractCallDeniedBridges(
  fromChainId: number,
  toChainId: number | undefined,
  toToken: string | undefined | null,
): string[] | undefined {
  if (toChainId === undefined || toChainId === fromChainId) return undefined;
  if (!isLifiNativeToken(toToken)) return undefined;
  return [...LIFI_NATIVE_DELIVERY_DENIED_BRIDGES];
}

type QuoteParams = { fromChainId: number; toChainId?: number; toToken: string };
type ContractCallProvider = {
  getSwapAndDepositQuote: (params: never) => Promise<unknown>;
};

/**
 * Adds the deny list above to the SDK's LiFi contract-call quotes. The SDK has
 * no deny-bridges param, but builds its request synchronously through the
 * instance's `bridgeFilter` before its first await, so the list is scoped to
 * exactly the call that set it. Install AFTER any other wrapper of
 * `getSwapAndDepositQuote`, so it sees the final params.
 */
export function installNativeDeliveryBridgeDeny(provider: ContractCallProvider): void {
  const host = provider as unknown as {
    bridgeFilter?: (fromChainId: number, toChainId: number) => Record<string, unknown>;
    getSwapAndDepositQuote: (params: QuoteParams) => Promise<unknown>;
  };
  if (typeof host.bridgeFilter !== 'function') {
    throw new Error('LiFi provider has no bridgeFilter: re-check services/lifi-native-delivery.ts against the SDK.');
  }
  const realBridgeFilter = host.bridgeFilter.bind(provider);
  const realQuote = host.getSwapAndDepositQuote.bind(provider);
  let deniedForCall: string[] | undefined;
  host.bridgeFilter = (fromChainId, toChainId) => ({
    ...realBridgeFilter(fromChainId, toChainId),
    ...(deniedForCall && fromChainId !== toChainId ? { denyBridges: deniedForCall } : {}),
  });
  host.getSwapAndDepositQuote = (params) => {
    deniedForCall = contractCallDeniedBridges(params.fromChainId, params.toChainId, params.toToken);
    try {
      return realQuote(params);
    } finally {
      deniedForCall = undefined;
    }
  };
}

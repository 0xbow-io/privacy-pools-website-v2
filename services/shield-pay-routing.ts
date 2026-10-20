// Is the asset the wallet PAYS with already this pool's own deposit asset?
//
// Two ways it can be: the pay token IS the pool asset, or the pool asset is a
// yield share whose UNDERLYING the pay token is - the PPRouter wraps it inside
// the same deposit, so mainnet USDC into the ppUSDC pool is that pool's
// ordinary deposit and not a conversion.
//
// This lived inline in components/home/action-hub.tsx and was wrong twice:
//   2026-09-04  compared addresses only, so USDT into the ppUSDT pool was
//               classified as a conversion, found no LiFi route into a share
//               and refused with "Converting USDT isn't available on this
//               network" - on the one pool that asset can enter.
//   2026-09-12  asked the vault-VERIFIED resolver. The probe runs at session
//               creation, so until it answered the same refusal came back for
//               USDC, and the destination fell through to another pool.
//
// The second one survived a test that reproduced the predicate here instead of
// importing it, so fixing the component left the test passing. It lives in a
// module now: the hub imports THIS, and so does the test.
//
// Which resolver to inject: the CONFIGURED one. The question is what an asset
// IS relative to a pool, which the build's deployment table answers on its
// own. Whether money may move through that route is a different question,
// asked at send time against the verified gate (components/deposit-modal-
// provider.tsx), and nothing here relaxes it.
import { getConfiguredYieldDeploymentForAsset } from '@/config/yield';

/** The native-coin sentinel every chain config and the SDK use. */
const NATIVE_PAY_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/** Pure: injected resolver, so a test can drive both the configured and the verified answer. */
export function resolvePayWrapsIntoPool(
  args: { payChainId: number; poolChainId: number; poolAddress: string; payAddress: string | undefined },
  deploymentForAsset: (chainId: number, tokenAddress: string) => { underlying: string; nativeMode?: boolean } | undefined,
): boolean {
  if (!args.payAddress) return false;
  // The wallet has to be on the pool's chain: paying across chains goes through
  // the swap route (LiFi bridges, then calls the deposit), which is a conversion
  // however the far leg ends, and not this pool's direct deposit.
  if (args.poolChainId !== args.payChainId) return false;
  const deployment = deploymentForAsset(args.poolChainId, args.poolAddress);
  if (!deployment) return false;
  const pay = args.payAddress.toLowerCase();
  // A NATIVE-MODE share (ppETH) is minted from the chain's native coin: the
  // router wraps msg.value to WETH itself, so paying ETH is that pool's
  // ordinary deposit even though the deployment's underlying is WETH.
  if (deployment.nativeMode === true && pay === NATIVE_PAY_ADDRESS) return true;
  return deployment.underlying.toLowerCase() === pay;
}

/** The predicate the hub renders with. */
export function payWrapsIntoPool(args: {
  payChainId: number; poolChainId: number; poolAddress: string; payAddress: string | undefined;
}): boolean {
  return resolvePayWrapsIntoPool(args, getConfiguredYieldDeploymentForAsset);
}

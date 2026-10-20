/**
 * Links this app hands out from the Stellar network (pay links, claim links).
 *
 * A fresh browser opening a bare link lands in the build's default world with
 * no Stellar opt-in, so it cannot select the network the link is for. Every
 * Stellar link therefore carries `?stellar=true` (the opt-in) and the world it
 * was made in (`?env=`), which outranks whatever the opener has stored.
 *
 * Pure module (no react-native) so it is bun-testable.
 */
import { APP_ENVIRONMENT_QUERY_PARAM, type AppEnvironment } from '@/config/app-environment';
import { STAGING_MAINNET_ENV_VALUE } from '@/config/staging-mainnet';

export function withStellarLinkParams(
  href: string,
  env: AppEnvironment,
  /** The maker opted into `?env=staging-mainnet`: keep that, not plain staging. */
  opts: { stagingMainnet?: boolean } = {},
): string {
  try {
    const url = new URL(href);
    url.searchParams.set('stellar', 'true');
    url.searchParams.set(APP_ENVIRONMENT_QUERY_PARAM, env === 'staging' && opts.stagingMainnet ? STAGING_MAINNET_ENV_VALUE : env);
    return url.toString();
  } catch {
    return href;
  }
}

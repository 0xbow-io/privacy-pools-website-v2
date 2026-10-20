/** Intent surfaces are ON by default, with per-chain/target capability gates
 * behind them. EXPO_PUBLIC_INTENT_LOCKDOWN=true hides them for a deployment
 * that needs them dark. The URL escape hatch only exposes Swap; it never
 * bypasses route capabilities.
 *
 * A deployment that sets nothing gets the surface — "so it just works" (Pat,
 * 2026-09-21). This briefly shipped inverted (#73) and, because the variable
 * is not set in Vercel prod, the Swap tab vanished for everyone on that
 * deploy; this restores it.
 *
 * IMPORTANT: read the flag via a STATIC `process.env.EXPO_PUBLIC_*` member
 * expression. Expo/Metro only inlines static member access at build time; a
 * dynamic lookup resolves to `undefined` in the production web export and
 * "works" only in local dev (same warning as config/yield.ts).
 */
import { getUiParam } from '@/components/ui-url-events';
import { intentLockdownRequestedByEnv } from '@/services/intent-lockdown-rule';

/**
 * The lockdown itself: true = the intent surface is hidden.
 *
 * The rule lives in services/intent-lockdown-rule.ts so a bun test can assert
 * the default; this module reaches react-native through the URL helper above
 * and cannot be imported from one.
 */
export const INTENT_LOCKDOWN = intentLockdownRequestedByEnv(process.env.EXPO_PUBLIC_INTENT_LOCKDOWN);

/** `?swap=true` (or `?swap=1`) asks for the Swap tab back, for this tab only. */
export function swapRequestedByUrl(): boolean {
  const raw = getUiParam('swap');
  if (raw === null) return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === '';
}

/**
 * May the Swap tab be offered at all? Enabled unless explicitly locked down.
 * Everything downstream (the tab strip, the deep link, the flow itself) reads
 * this, so one answer decides the whole surface.
 */
export function swapSurfaceEnabled(): boolean {
  return !INTENT_LOCKDOWN || swapRequestedByUrl();
}

/**
 * May an action leave this chain or change the asset? Cross-chain delivery,
 * swap-and-deposit ("pay with X, shield Y"), reshield and "receive as" all ask
 * here. NO url escape hatch: those surfaces are spread across four flows and a
 * half-enabled one is worse than none. Flip the flag to bring them all back.
 */
export function crossFlowsEnabled(): boolean {
  return !INTENT_LOCKDOWN;
}

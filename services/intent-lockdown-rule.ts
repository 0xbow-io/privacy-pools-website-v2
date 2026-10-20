/**
 * The pure half of the intent lockdown: does this env value HIDE the surface?
 *
 * Split from config/intent-lockdown.ts for the reason config/tokens and
 * config/chains are split from their rules — that module reaches
 * components/ui-url-events for the `?swap=` escape hatch, which pulls in
 * react-native, which a bun test cannot parse ("Unexpected typeof"). The
 * default is the thing most worth a test, so the default lives here.
 */

/**
 * Default UNLOCKED: a deployment that sets nothing gets the conversion surface
 * (Pat, 2026-09-21 — "so it just works"). Only an explicit on-ish value locks
 * it, which is the switch to reach for when a chain's routes are not ready.
 *
 * Empty deserves its own mention, because it is the value the prod
 * capability-matrix harness passes and it has now meant both things: unset and
 * empty both mean UNLOCKED, so a variable that exists but was never given a
 * value cannot silently dark the surface.
 *
 * This briefly shipped inverted (#73, reverted here): the default was flipped
 * to locked, and since EXPO_PUBLIC_INTENT_LOCKDOWN is not set in Vercel prod
 * the Swap tab disappeared for everyone on that deploy. The capability gates
 * downstream are what decide whether any particular conversion can land; this
 * flag only decides whether the surface is offered at all.
 */
export function intentLockdownRequestedByEnv(raw: string | undefined | null): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return false;
  return value !== 'false' && value !== '0' && value !== 'off' && value !== 'no';
}

/**
 * What `?notifications=1` should do (DEV-454).
 *
 * The bell, and so its sheet, exists only for a wallet or account-key session
 * (header.tsx `menuActive`). The URL opened the sheet on its own, so a link
 * showed a signed-out visitor an empty Notifications sheet with no bell behind
 * it. With no session the param is dropped, but only once the wallet has
 * SETTLED: on a reload the wallet is still reconnecting, and stripping then
 * would close the sheet a connected user asked for.
 */
export function notificationsParamAction(args: {
  requested: boolean;
  sessionActive: boolean;
  walletSettling: boolean;
}): 'show' | 'wait' | 'strip' | 'none' {
  if (!args.requested) return 'none';
  if (args.sessionActive) return 'show';
  return args.walletSettling ? 'wait' : 'strip';
}

/**
 * The vault refusing a proof because the keystore root it was built against is
 * no longer one it accepts (PoolVault_UnknownKeystoreRoot). The grid repairs the
 * leaf set within one instant (services/keystore-root-guard.ts), so the honest
 * answer is "retry shortly", not the relayer's raw HTTP 400 body.
 *
 * Copy rules: say "exit", never name the data source or the contract internals.
 */
import { toFunctionSelector } from 'viem';

const SELECTOR = toFunctionSelector('error PoolVault_UnknownKeystoreRoot()').toLowerCase();

export function isUnknownKeystoreRoot(message: string): boolean {
  return /PoolVault_UnknownKeystoreRoot/i.test(message) || message.toLowerCase().includes(SELECTOR);
}

export function keystoreRootRefreshingMessage(flow: 'withdrawal' | 'exit' | 'transfer'): string {
  return flow === 'exit'
    ? 'Your data is refreshing. Try the exit again in a minute.'
    : `Your data is refreshing. Try the ${flow} again in a minute.`;
}

import { Pressable, Text } from 'react-native';

import { IS_STAGING_ONLY_HOST, applyAppEnvironment, withAppEnvironmentQuery } from '@/config/app-environment';
import type { ReceiptChain } from '@/services/receipt-chain';

/** Reload into the environment that serves the chain, keeping this URL. */
function switchTo(other: NonNullable<ReceiptChain['otherEnvironment']>): void {
  if (other.query === other.id) {
    applyAppEnvironment(other.id);
    return;
  }
  // `?env=staging-mainnet` is not an AppEnvironment value, it is staging plus
  // its mainnet pools; the next load reads and remembers it (staging-mainnet.ts).
  if (typeof window === 'undefined') return;
  const url = new URL(withAppEnvironmentQuery(window.location.href, other.id));
  url.searchParams.set('env', other.query);
  window.location.assign(url.toString());
}

/**
 * The body of a receipt's "Wrong network" notice. When the chain lives in the
 * other environment, the network picker cannot reach it, so name the
 * Environment switch and offer it (DEV-457). The switch reloads the same URL,
 * so a receipt LINK survives it and a pasted one does not.
 */
export function ReceiptWrongNetworkCopy({ chain, textClassName, pasted = false, noun = 'receipt' }: {
  chain: ReceiptChain;
  textClassName: string;
  /** A pasted receipt (the import modal) does not survive the reload. */
  pasted?: boolean;
  /** What the link is: a receipt to import, or a payment request to pay (DEV-485). */
  noun?: 'receipt' | 'request';
}) {
  const verb = noun === 'request' ? 'pay' : 'import';
  if (!chain.supported) {
    return <Text className={textClassName}>This {noun} is for {chain.name}, which this app does not support.</Text>;
  }
  const other = chain.otherEnvironment;
  if (!other) {
    return <Text className={textClassName}>This {noun} is for {chain.name}. Switch the app to {chain.name} to {verb} it.</Text>;
  }
  // A staging-only host (config/app-environment.ts) cannot switch worlds, so
  // there is nothing to offer: say where the link belongs instead of a button.
  if (IS_STAGING_ONLY_HOST) {
    return (
      <Text className={textClassName}>
        This {noun} is for {chain.name}, on {other.label}. Open it on the {other.label} site, this one only serves Staging.
      </Text>
    );
  }
  return (
    <>
      <Text className={textClassName}>
        This {noun} is for {chain.name}, on {other.label}.{pasted ? ' Paste it again after switching.' : ''}
      </Text>
      <Pressable
        testID="receipt-switch-environment"
        accessibilityRole="button"
        onPress={() => switchTo(other)}
        className="self-start rounded-control border border-warning px-[10px] py-[6px]"
      >
        <Text className="font-pp-medium text-[12px] text-warning">Switch to {other.label}</Text>
      </Pressable>
    </>
  );
}

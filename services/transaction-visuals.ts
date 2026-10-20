import type { Ionicons } from '@expo/vector-icons';

/**
 * How a transaction type looks wherever it is listed.
 *
 * One glyph per kind, all bare line/stroke icons so the set reads as one
 * family; direction and a per-action colour carry the meaning.
 *
 * Adapted from feat/ui-overhaul so the activity list matches that design, but
 * keyed to OUR theme tokens rather than that branch's palette module — the
 * colours therefore track whichever of the five design variants (and light or
 * dark) is active, instead of hardcoding one scheme.
 */
export type TransactionGlyph = keyof typeof Ionicons.glyphMap;

const TRANSACTION_TYPE_GLYPH: Record<string, TransactionGlyph> = {
  Deposit: 'arrow-down',
  Withdrawal: 'arrow-up',
  'Transfer In': 'swap-horizontal',
  'Transfer Out': 'swap-horizontal',
  'Transfer In & registration': 'swap-horizontal',
  // Account setup paid from the balance (DEV-574).
  'Gas for viewing key': 'flame-outline',
  'Account setup': 'key-outline',
  // A deposit made for someone else: money leaving the payer, like a withdrawal.
  'Deposit to recipient': 'arrow-up',
  // A private swap-send: money left this account.
  'Sent to another account': 'arrow-up',
  Transfer: 'swap-horizontal',
  // A private swap: one pool's asset into another's.
  Swap: 'swap-vertical',
  Exit: 'exit-outline',
};

/** Reduce a directional type ("Transfer In/Out") to its base ("Transfer"). */
export function transactionBaseType(type: string): string {
  const cased = (type ?? '').charAt(0).toUpperCase() + (type ?? '').slice(1);
  if (cased === 'Deposit to recipient') return 'Withdrawal';
  if (cased === 'Deposit via swap') return 'Deposit';
  if (cased === 'Withdrawal via swap' || cased === 'Sent to another account') return 'Withdrawal';
  return cased.startsWith('Transfer') ? 'Transfer' : cased;
}

export function transactionTypeGlyph(type: string, baseType?: string): TransactionGlyph {
  return (
    TRANSACTION_TYPE_GLYPH[type]
    ?? (baseType ? TRANSACTION_TYPE_GLYPH[baseType] : undefined)
    ?? 'ellipse-outline'
  );
}

/**
 * Each action gets its own hue so the type reads by colour as well as glyph:
 * deposit green (funds in), transfer purple, exit red (the privacy forfeit),
 * withdrawal neutral.
 *
 * Transfer purple is bespoke — it is deliberately set apart from the app's
 * primary hue, which differs per design variant and would collide.
 */
const TRANSFER_TYPE_COLOR = { light: '#7C3AED', dark: '#A78BFA' } as const;

export function transactionTypeColor(
  baseType: string,
  colors: { success: string; danger: string; textMuted: string },
  scheme: 'light' | 'dark',
): string {
  if (baseType === 'Deposit') return colors.success;
  // A swap shares the transfer hue: value moving inside the pool.
  if (baseType === 'Transfer' || baseType === 'Swap') return TRANSFER_TYPE_COLOR[scheme];
  if (baseType === 'Exit') return colors.danger;
  return colors.textMuted;
}

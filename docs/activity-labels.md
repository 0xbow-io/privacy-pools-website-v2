# Activity labels

One user action is one row. The label and the amount sign follow what happened
to the user's balance. Supporting legs (relayer fee, LiFi leg, gas top-up,
change note) are rows inside View details, never rows of their own.

Source of truth in code: `services/row-type-label.ts` (label),
`services/transaction-visuals.ts` (icon), `services/relayer-fee-row.ts` (the
Relayer fee detail). `services/accounting-export.ts` uses the same labels in the
CSV description. Tests: `services/__tests__/activity-labels.test.ts` checks every
label below against this file.

| Action | Label | Icon / direction | Amount sign | Collapses into the row (View details) |
| -- | -- | -- | -- | -- |
| Deposit from my wallet | Deposit | arrow down, in | + | Deposit #, ASP status |
| Deposit I made for someone else (Mine and details; All says Deposit) | Deposit to recipient | arrow up, out | - | Recipient |
| Shield swap (wallet token swapped, then deposited) | Deposit via swap | arrow down, in | + | Swap leg, LiFi route |
| Withdrawal | Withdrawal | arrow up, out | - | Relayer fee, Net after fee |
| Withdrawal through a swap route (receive as, cross-chain made elsewhere) | Withdrawal via swap | arrow up, out | - | Relayer fee, LiFi route, received leg |
| Private swap-send to another account | Sent to another account | arrow up, out | - | Relayer fee, LiFi route |
| Send / paid payment request | Transfer Out | swap, out | - | Recipient, Relayer fee, Total spent |
| Payment received | Transfer In | swap, in | + | none |
| Payment link claimed on my device | Transfer In | swap, in | + | Relayer fee, Claim fee, claim tx |
| Payment link claimed with registration in the same tx | Transfer In & registration | swap, in | + | Relayer fee, Claim and registration fee |
| Swap (same chain or cross-chain, Swap tab) | Swap | swap vertical | - source, + output | Effective rate, Relayer fee, receive tx, LiFi route |
| Exit / ragequit | Exit | exit | - | none (self-paid, no relayer fee) |
| Gas top-up that pays for the viewing key | Gas for viewing key | flame, cost | - | Relayer fee |
| Gasless registration paid from the balance | Account setup | key, cost | - | Relayer fee |
| Transfer to myself | Self-transfer | swap, self | fee only | Recipient (me), Amount moved, Relayer fee |
| Consolidate notes | Consolidation | swap, self | fee only | Notes, Amount moved, Relayer fee |

## Rules

- Direction is the net balance change. A claim is submitted from the
  recipient's own device, but the balance went up, so it is In. It is
  recognised from local claim records and anchor stamps. Both are written
  only after our nullifiers are confirmed spent by the claim; an unsuccessful
  attempt cannot turn a later withdrawal into incoming activity.
- Setup spends are recorded locally when they are made
  (`own-actions` kinds `setup-gas` and `setup-register`). A row with no record
  (another device, cleared storage) keeps its chain shape label.
- The Relayer fee row shows the fee recorded at submit time (or the chain's
  figure for an outgoing transfer), in the token it was taken in, with the
  review step's format, for example `0.155523 USDT (~$0.16)`. No stored or
  chain fee data, no row: never `0`, never a re-quote.
- Labels come from local data only. No request is made to name a row.

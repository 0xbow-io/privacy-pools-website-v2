# Public Stellar fee helpers

Generated from the source map shipped in the pinned `@privacy-pools-v2/stellar-sdk`
package (0xbow v2-monorepo revision `1449fe37`, p30). Source contents, resource
calibrations, arithmetic, and the public configuration read are unchanged.
The generator replaces only the broad internal barrel with a fee-only barrel.
The SDK root eagerly imports proving and wallet code; background pricing must
not load those dependencies for every visitor. This module imports only the
existing Stellar library and zod. No new dependency or network service is added.

Regenerate after updating the pinned SDK:

```
bun scripts/stellar/build-fee-module.mjs
bun scripts/stellar/build-fee-module.mjs --check
```

Do not edit generated `index.js`. Tests compare this module's results and public
ledger keys against the installed SDK. Replace this extraction with a supported
SDK pricing subpath when one is available.

The application reads these public settings every minute on the shared feed grid
in builds that include Stellar, including sessions without Stellar opt-in. It
calculates all five transfer and withdrawal input counts locally. A failed read or settings at
least two minutes old makes the displayed estimate unavailable; it does not initiate
an extra request. The SDK can retry a public RPC snapshot-gap error once.
The client uses dev's direct Soroban URL. Ports to branches with anonymous RPC
routing must apply that routing to this client too.

The native-XLM estimate adds 200,000 stroops flat fee and 100 stroops inclusion
to the resource fee with a 25% margin rounded up. This policy must be updated
alongside relayer configuration. The settings fixture was captured at testnet
ledger 5,681,871; at those settings all five shapes matched public unsigned
quotes (317289, 390145, 437862, 460439, 483015 stroops). This comparison does not
establish the deployed relayer image revision. Withdrawals price the costlier of the relay and registration
actions with n inputs and n outputs, then add the amount fee (50 basis points, rounded down)
and cap the total at 5,000,000 stroops. At the fixture settings, public unsigned
quotes for a 1 XLM withdrawal matched all five local estimates: 445273, 492989,
540703, 588420, and 636137 stroops.

Send, payment requests, and saving a claimed link share the transfer estimates.
Withdrawal fee, total, and remaining displays use the withdrawal estimate.
The transfer ceiling of 750,000 stroops and the existing withdrawal reserve
still determine affordability. Signed quotes must also stay within the displayed
estimate plus the existing EVM reviewed-fee allowance (1%, with a 16-unit floor).

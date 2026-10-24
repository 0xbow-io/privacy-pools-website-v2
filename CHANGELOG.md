# Changelog

All notable changes to the Privacy Pools v2 web app are documented in this file.

## [1.2.2] - 2026-10-24

### Fixed
- remove duplicate receive assets across chains
- derive own deposit review locally when the feed carries none
- Keep share-link payloads out of the request path

## [1.2.1] - 2026-10-23

### Fixed
- Browser Back and Forward retain entered amounts and open Home panels.
- Cross-chain token selections carry the chosen asset and amount to the matching pool page without putting form values in the URL.
- Pasted token addresses are resolved on the selected network, and destination pickers no longer read public-wallet balances.
- Pool links remain available when yield deposits are disabled, and selecting a pool tab no longer opens the Withdraw dialog.

### Changed
- Pool pages, balances and token selectors use consistent bundled chain and token logos.
- Pool browsing combines chain and asset selection in one menu, with updated balance, activity and statistics layouts.

## [1.2.0] - 2026-10-22

### Added
- Unwrap ppETH, ppUSDC and ppUSDT shares left in your wallet, from Portfolio and as part of ragequit.
- Wallets that support EIP-5792 confirm approve and deposit, and ragequit and unwrap, in one step.

### Changed
- Share pool balances, fees and activity read as the underlying asset (0.10 ETH), with the share count in the (i) hint. MAX and the amount fields follow.

### Fixed
- The Swap tab no longer crashes (React #185) when the page sits near the scrollbar threshold.

## [1.1.0] - 2026-10-21

### Added
- Optional anonymous error reports with stage, reason and scrubbed stacks.

### Fixed
- Share pool balances show the underlying asset they are worth, so ppETH no longer looks like a smaller balance.
- Show more and the end of every list stay clear of the bottom tab bar on mobile.
- A multi-part withdrawal that fails after part of it was sent is reported as sent.
- The official Arbitrum One logo.

## [1.0.0] - 2026-10-20

First public release of the Privacy Pools v2 web app, live at https://privacypools.com.

### Added
- Shield, withdraw and private send on Ethereum, BNB Chain and Citrea, through relayers.
- Swaps into and out of pool assets, and cross-chain shield.
- Payment requests and claim links for recipients who have not registered yet.
- Sign-in with a wallet signature or a passkey.
- Yield on ppAssets.
- Fee warnings when fees are a large share of the amount.
- In-app Terms of Use and Privacy Policy.
- Groth16 verifier keys from the trusted-setup ceremony (SDK 1.0.2).

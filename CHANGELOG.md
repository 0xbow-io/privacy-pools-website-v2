# Changelog

All notable changes to the Privacy Pools v2 web app are documented in this file.

## [1.6.0] - 2026-11-17

### Added
- Stellar: keystore registration screen, so a Stellar account can register for private sends (#94).
- Releases are tagged and published from main automatically, with reproducible static bundles, circuits, hashes and IPFS proofs attached (#90, #98).

### Changed
- The Stellar wallet is now Varial, with an updated connection flow (#91).
- Stellar relayed operations show the estimated fee before you confirm (#93).
- Account checks use bulk background registry scans instead of per-account fallback requests (#97).

### Fixed
- Stellar: switching accounts in the wallet keeps each unlocked session, so switching back needs no new signature (#79).
- Stellar: one-time link sends go through the relayer (#76), and a failed one-time send is decided by the relayer's answer, so a link is only dropped when the send really failed (#99).
- Stellar: relayed transfers and payments build their proof once (#81), the one-time receipt box shows the link, deposit steps are labelled accurately (#80), and deposit-for and claimed-link rows show correctly in activity (#69).
- Swap converts a typed coin amount to shares before preparing it (#87).
- Entered yield payout amounts are covered and the prepared shares are verified (#92).
- Paged event snapshots are followed to the last page (#96).
- End-to-end tests: unlock gate recovery, fixture budget and recipient fields (#95), and the Stellar fee poll no longer trips the privacy gate (#101).

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

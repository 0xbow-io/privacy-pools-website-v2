# Changelog

All notable changes to the Privacy Pools v2 web app are documented in this file.

## [1.4.0] - 2026-11-10

### Added
- Stellar testnet: relayed Send, /pay links and claim links, a claim link when you deposit for an unregistered account, and the relayer fee shown before you send (#70).
- Ecosystem directory aligned with the app design, plus Nymis and Casberi (#40, #65).
- Turnstile loader served from our own origin and pinned by hash.
- Faster builds: circuit artifacts served from their own origin, with a reload notice when a cached file goes stale.
- Release PRs cut automatically from main with release-please (#28).

### Changed
- Share pool names no longer reach the screen (#72).
- Mobile bottom bar is now Shield, Portfolio, Explore and More, with activity inside Portfolio (#32).
- Explore pool cards show their stats on one grid with a consistent pool size (#35).
- Portfolio shows yield earned on every chain, and the tile shows the known total (#67).
- Large recommended amounts read 10k, 100k and 1M (#61).
- Withdraw shows thousands separators on every figure and the redeemed amount in the receive preview.
- The Swap tab is pinned to BNB Chain on prod, with an explanation of the swap value cap (#24).
- The wallet prices BNB Chain transactions, and a refused send says why (#25).
- Connection settings and privacy disclosures are clearer.
- Staging is the only environment on test.privacypools.com, with no environment switch there.

### Fixed
- Exit rebuilds keystore leaves from the chain when the ASP list is behind (#77).
- A root mismatch re-syncs once before it is shown (#62).
- A throttled relayer read no longer blocks a yield shield (#59).
- A failed wallet type check no longer blocks sign-in (#30), and the wallet unlock can use another passkey without silently creating one (#63).
- Account unlock checks and note recovery are hardened (#22).
- A crash in the Swap tab or a modal no longer takes the whole page down (#56).
- Error reports carry a placeholder location (#57), refuse token and chain names by registry, and read Firefox anonymous frames.
- The footer Support link opens the support Telegram instead of a 404 (#64).
- Stellar: protocol-30 ledger headers, claimed notes can be spent, relayed sends keep the recipient's note secrets, Freighter signing windows, and no EVM unlock on a Stellar landing.
- Sepolia e2e journeys use the keys its verifiers hold (#74).
- Dependency audit findings fixed, with a bun audit CI gate (#58).
- Send, payment request and claim flows no longer show share names (#29).
- The share-name guard no longer flags the gasless-registration refusal (#83).
- The Swap tab no longer shows share names, and the first swap no longer wrongly says the note is not approved (#26).

## [1.3.0] - 2026-10-29

### Added
- A notice at the top of the app that deposits are paused for yield assets on Ethereum and Base because of Aave's reserve freeze, with a link to Aave's announcement. Withdrawals, Send and Portfolio are not affected.

### Changed
- An opt-in setting can pause new deposits into the yield vaults per chain, off by default. When it is on, those assets show "Deposits paused" and Shield, swaps and pool pages refuse the deposit before anything is signed.

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

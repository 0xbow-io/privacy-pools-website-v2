# Changelog

All notable changes to the Privacy Pools v2 web app are documented in this file.

## [1.7.0] - 2026-11-24

### Added
- Stellar testnet (staging only): testnet XLM in the action widget, with the session unlocked before withdrawal review (#111).
- Circuit artifacts include witness graphs (#128).

### Changed
- SDK 1.2.0: swap and reshield quotes carry the number of notes the relay spends, so the relayer prices multi-note swaps correctly (#129).
- Swap shows the estimated shielded note with its fees and dust before Review, sized the same way the SDK executor sizes it (#112).
- Relay errors show short copy instead of raw relayer HTTP text, including when a quoted fee no longer covers the cost (#126).
- Dollar figures always show two decimals (#127).

### Fixed
- The activity feed no longer drops about a third of its rows: rows are keyed on chain and type, not the per-table event id alone (#124).
- A relayed withdrawal that reverts because the approved set moved is proved again once and retried (#125).
- Withdraw on another chain's portfolio row opens that chain's pool, the Shield card on a pool page starts on that pool's asset and keeps its pay token selected, and the My transactions filters are no longer clipped (#127, #130).
- A chain whose snapshot lands mid-sweep is scanned instead of skipped (#127).
- Testnet and staging (`?env=staging`) withdrawals no longer fail with `PoolVault_InvalidTransactProof`: both default to the Sepolia V8 deployment, whose verifier keys match the app's circuits, with its relayer, keystore and ASP registry. Existing V9 testnet notes stay on V9. Prod is unchanged (#113).

## [1.6.2] - 2026-11-20

### Changed
- The app uses the released SDK `@0xbow/privacy-pools-v2-sdk@1.1.0` instead of a build of its main branch. The SDK code is byte-identical to what 1.6.1 shipped, so nothing changes for users (#121).

## [1.6.1] - 2026-11-20

### Changed
- Explore shows the total deposited in place of accepted, and drops the Pending column (#102).
- `smithers-orchestrator`, local tooling the app never imports, is a dev dependency, which takes `effect` out of the production dependency audit (#118).

### Fixed
- Withdrawals and sends that spend more than one note are no longer refused by the relayer: quotes now carry the number of notes the proof spends and creates, which the relayer prices since its 2026-11-20 update. Fee estimates and consolidation follow the same counts, and a send-exact transfer never debits more than the entered amount (#116).
- Swap Review lines add up: costs round up to the cent, the swap output is shown in its own units, and dust has its own row (#106, #109).
- Stellar testnet (staging only): a payment request can be paid from the wallet, with a clear message when it times out (#107).
- End-to-end tests: the payment group's fee reserve fits the funded balance (#108).

## [1.6.0] - 2026-11-17

### Added
- Stellar testnet (staging only, behind debug): keystore registration screen, so a Stellar account can register for private sends (#94).
- Releases are tagged and published from main automatically, with reproducible static bundles, circuits, hashes and IPFS proofs attached (#90, #98).

### Changed
- Stellar testnet (staging only): the Stellar wallet is now Varial, with an updated connection flow (#91).
- Stellar testnet (staging only): relayed operations show the estimated fee before you confirm (#93).
- Account checks use bulk background registry scans instead of per-account fallback requests (#97).

### Fixed
- Stellar testnet (staging only): switching accounts in the wallet keeps each unlocked session, so switching back needs no new signature (#79).
- Stellar testnet (staging only): one-time link sends go through the relayer (#76), and a failed one-time send is decided by the relayer's answer, so a link is only dropped when the send really failed (#99).
- Stellar testnet (staging only): relayed transfers and payments build their proof once (#81), the one-time receipt box shows the link, deposit steps are labelled accurately (#80), and deposit-for and claimed-link rows show correctly in activity (#69).
- Exit works when the ASP is down: every prod chain is pinned, so it no longer waits on the ASP for the entrypoint (#100).
- Staging and testing point at the real relayers again (EVM and Stellar testnet) instead of placeholder hosts (#104).
- Swap converts a typed coin amount to shares before preparing it (#87).
- Entered yield payout amounts are covered and the prepared shares are verified (#92).
- Paged event snapshots are followed to the last page (#96).
- End-to-end tests: unlock gate recovery, fixture budget and recipient fields (#95), and the Stellar fee poll no longer trips the privacy gate (#101).

## [1.5.0] - 2026-11-10

### Added
- Contacts: every recipient field suggests your previous recipients, with local names you can set, and Settings can import and export the list. Stored on the device only (#37).

### Changed
- An empty recipient on Withdraw no longer falls back to the connected wallet. It asks for an address instead (#37).
- Sign-in and deposit check your keystore identity against the bulk ASP registries instead of asking the RPC about your account (#34).

### Fixed
- Payroll pays the exact salary in the coin. Yield pools no longer overpay by the share rate (#78).
- Playwright scripts run on Chrome stable with the sandbox on and refuse an older Chrome (#60).

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

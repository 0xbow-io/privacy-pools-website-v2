/** DEV-573: what opening a block explorer gives away, named per explorer. */
export function explorerPrivacyText(explorerName: string): string {
  return `Opening the explorer shares your IP address with ${explorerName} and links it to this transaction. Use a VPN or Tor if that matters to you.`;
}

/** Names the explorer by its host when the chain is not at hand (e.g. etherscan.io). */
export function explorerNameFromUrl(url: string | null | undefined): string {
  try {
    return new URL(url ?? '').hostname.replace(/^www\./, '') || 'the explorer';
  } catch {
    return 'the explorer';
  }
}

export function shouldAutoPickWithdrawToken(params: {
  isOpen: boolean;
  didAutoPick: boolean;
  hasPreferredTransactionAsset: boolean;
  hasExplicitTokenPin: boolean;
}): boolean {
  return params.isOpen
    && !params.didAutoPick
    && !params.hasPreferredTransactionAsset
    && !params.hasExplicitTokenPin;
}

// Public surface of the embedded-wallet module.

export * from './types';
export * from './constants';
export {
  hasWallet,
  getWalletMeta,
  canUsePasskey,
  createWallet,
  unlockWallet,
  recoverWallet,
  wipeWallet,
} from './account';
export {
  embeddedConnector,
  EMBEDDED_CONNECTOR_ID,
  setActiveEmbeddedWallet,
  clearActiveEmbeddedWallet,
  getActiveEmbeddedWallet,
  onActiveWalletChange,
} from './connector';

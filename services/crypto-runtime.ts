// Native and standalone consumers load only the cryptography they request.
export const loadSdkCore = () => import('@privacy-pools-v2/sdk');
export const loadPoseidon = () => import('circomlibjs');
export const loadGroth16 = () => import('snarkjs');

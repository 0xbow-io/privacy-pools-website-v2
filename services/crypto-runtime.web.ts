// Metro hoists dependencies shared by async chunks into the initial bundle.
// One web entry keeps SDK, Poseidon and proving code together until requested.
export const loadSdkCore = () => import('./sdk-runtime');
export const loadPoseidon = loadSdkCore;
export const loadGroth16 = loadSdkCore;

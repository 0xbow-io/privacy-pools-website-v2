// Disposable wallet: no keys, signing, or transaction submission.
export async function installLandingWallet(page) {
    await page.addInitScript(() => {
      window.landingSignRequests = [];
      let address = '0x0000000000000000000000000000000000000123';
      let connected = sessionStorage.getItem('landing-test-connected') === 'true';
      const listeners = new Map();
      const restoreWaiters = [];
      const provider = {
        on(event, callback) {
          const callbacks = listeners.get(event) ?? new Set();
          callbacks.add(callback);
          listeners.set(event, callbacks);
        },
        removeListener(event, callback) { listeners.get(event)?.delete(callback); },
        async request({ method }) {
          if (/sign/i.test(method)) window.landingSignRequests.push(method);
          if (method === 'eth_requestAccounts') { if (window.holdLandingConnect) await new Promise(resolve => { window.releaseLandingConnect = resolve; }); connected = true; sessionStorage.setItem('landing-test-connected', 'true'); return [address]; }
          if (method === 'eth_accounts') {
            if (sessionStorage.getItem('landing-test-hold-restore') === 'true') {
              window.landingRestoreRequested = true;
              await new Promise(resolve => {
                restoreWaiters.push(resolve);
                window.releaseLandingRestore = () => {
                  sessionStorage.removeItem('landing-test-hold-restore');
                  restoreWaiters.splice(0).forEach(release => release());
                };
              });
            }
            return connected ? [address] : [];
          }
          if (method === 'eth_chainId') return '0xaa36a7';
          if (method === 'wallet_requestPermissions' || method === 'wallet_getPermissions') return [{ parentCapability: 'eth_accounts' }];
          if (method === 'wallet_getCapabilities') return {};
          throw Object.assign(new Error(`Fixture rejects ${method}`), { code: 4001 });
        },
      };
      window.switchLandingWallet = next => {
        address = next;
        for (const callback of listeners.get('accountsChanged') ?? []) callback([address]);
      };
      window.disconnectLandingWallet = () => {
        connected = false;
        sessionStorage.removeItem('landing-test-connected');
        for (const callback of listeners.get('accountsChanged') ?? []) callback([]);
      };
      const detail = {
        info: { uuid: '4b1cbe4e-8e30-4f7a-9a5a-000000006963', name: 'Landing Test Wallet', rdns: 'io.test.landing', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>' },
        provider,
      };
      window.ethereum = provider;
      window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })));
    });
}

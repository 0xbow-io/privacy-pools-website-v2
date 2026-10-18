/**
 * A viem transport that applies the egress policy before the call leaves.
 *
 * Covers app-owned EVM HTTP transports, including SDK and embedded-wallet
 * clients. Injected wallets and WalletConnect own their network connections;
 * wrapping wagmi's public transports does not intercept those providers.
 *
 * That is not hypothetical: the 2026-08-26 leak was 108 per-nullifier
 * `eth_call`s issued by SDK internals during a single send, one of them for
 * the nullifier that appeared on-chain fifteen seconds later. Nothing in this
 * repo's source named them.
 *
 * Interception is at the EIP-1193 `request` level, before viem serialises or
 * batches, so a batched provider cannot smuggle a refused call inside a
 * legitimate batch.
 */
import { http, stringify, type HttpTransport, type HttpTransportConfig } from 'viem';

import { assertEgressAllowed, EgressRefusedError } from '@/services/egress-policy';
import { rpcTimeoutMs, torFetchIfActive } from '@/services/tor-fetch';

type RpcArgs = { method: string; params?: unknown };

/**
 * `http()` with the egress policy in front of it.
 *
 * A drop-in replacement: same arguments, same behaviour, except that a call
 * the policy refuses throws EgressRefusedError instead of reaching the
 * provider.
 */
export function policedHttp(url?: string, config?: HttpTransportConfig): HttpTransport {
  return ((params: Parameters<HttpTransport>[0]) => {
    const endpoint = url || params.chain?.rpcUrls.default.http[0] || '';
    const inner = http(url, {
      ...config,
      // Check again after batching, fetchOptions, and onFetchRequest. Those
      // hooks can otherwise change a request after the EIP-1193 check.
      async fetchFn(input, init) {
        const target = new URL(input instanceof Request ? input.url : String(input));
        if (target.href !== new URL(endpoint).href || target.username || target.password) {
          throw new EgressRefusedError('rpc', 'request is outside the configured RPC endpoint');
        }
        const headers = new Headers(init?.headers);
        assertEgressAllowed('rpc', {
          method: init?.method ?? 'POST',
          url: endpoint,
          headers: Object.fromEntries(headers.entries()),
          body: typeof init?.body === 'string' ? init.body : null,
        });
        // Tor, when the user has asked for it, sits HERE: underneath the
        // allowlist check above rather than around it, so it changes how a
        // permitted request travels and never what may be sent. Null when Tor
        // is off, and services/tor-fetch.ts throws rather than falling back,
        // so a broken gateway fails the call instead of quietly sending it
        // direct (see the note there).
        const send = torFetchIfActive() ?? config?.fetchFn ?? fetch;
        return send(input, {
          ...init, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
        });
      },
    });
    // Tor's first call to a host builds its route across the network, which
    // a direct call's timeout does not allow for (see rpcTimeoutMs). Applied
    // to the timeout viem uses, which a caller's params override.
    const transport = inner({ ...params, timeout: rpcTimeoutMs(params.timeout ?? config?.timeout) });
    const innerRequest = transport.request;
    const request = (async (args: RpcArgs, options) => {
      assertEgressAllowed('rpc', {
        method: 'POST',
        url: endpoint,
        headers: Object.fromEntries(new Headers(config?.fetchOptions?.headers).entries()),
        body: stringify({ method: args.method, params: args.params ?? [] }),
      });
      return innerRequest(args as Parameters<typeof innerRequest>[0], options);
    }) as typeof transport.request;
    return {
      ...transport,
      config: { ...transport.config, request },
      request,
    };
  }) as HttpTransport;
}

import type { IHTTPClient, HTTPRequestOptions } from '@privacy-pools-v2/sdk';
import type { EgressIntent } from '@/services/egress-policy';
import { policedFetch } from '@/services/egress-fetch';

/** SDK HTTP adapter; checks the exact headers and serialized body it sends. */
export class FetchHTTPClient implements IHTTPClient {
  /**
   * @param party which policy applies to everything this client sends
   * @param baseUrl the ONLY host it may talk to; anything else is refused
   */
  constructor(
    private readonly party: 'asp' | 'relayer',
    private readonly baseUrl: string,
    private readonly intent?: EgressIntent,
  ) {}

  async get<T>(url: string, options?: HTTPRequestOptions): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options?.timeout ?? 30_000);
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const response = await policedFetch(this.party, this.baseUrl, url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', ...options?.headers },
        signal: controller.signal,
      }, this.intent);
      if (!response.ok) {
        // Read the response body into the error: on HTTP/2 statusText is empty,
        // so without the body a relayer/ASP 400 surfaces as a useless "HTTP 400:".
        // The body carries the actual reason (validation issues, simulate revert).
        const errorBody = await response.text().catch(() => undefined);
        // Join only non-empty parts so an empty statusText never yields "HTTP 400: ".
        const detail = [response.statusText, errorBody?.slice(0, 500)].filter(Boolean).join(': ');
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async post<T>(url: string, body: unknown, options?: HTTPRequestOptions): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options?.timeout ?? 30_000);
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const response = await policedFetch(this.party, this.baseUrl, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...options?.headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      }, this.intent);
      if (!response.ok) {
        // Read the response body into the error: on HTTP/2 statusText is empty,
        // so without the body a relayer/ASP 400 surfaces as a useless "HTTP 400:".
        // The body carries the actual reason (validation issues, simulate revert).
        const errorBody = await response.text().catch(() => undefined);
        // Join only non-empty parts so an empty statusText never yields "HTTP 400: ".
        const detail = [response.statusText, errorBody?.slice(0, 500)].filter(Boolean).join(': ');
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Added in upstream IHTTPClient — used by IpfsCircuitArtifacts to
  // pull binary circuit assets. We don't ship IPFS-fetched circuits
  // (we use LocalCircuitArtifacts), so the implementation is just a
  // straight binary fetch with the same retry/abort semantics as
  // get/post.
  async getBinary(url: string, options?: HTTPRequestOptions): Promise<Uint8Array> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options?.timeout ?? 30_000);
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const response = await policedFetch(this.party, this.baseUrl, url, {
        method: 'GET',
        headers: { ...options?.headers },
        signal: controller.signal,
      }, this.intent);
      if (!response.ok) {
        // Read the response body into the error: on HTTP/2 statusText is empty,
        // so without the body a relayer/ASP 400 surfaces as a useless "HTTP 400:".
        // The body carries the actual reason (validation issues, simulate revert).
        const errorBody = await response.text().catch(() => undefined);
        // Join only non-empty parts so an empty statusText never yields "HTTP 400: ".
        const detail = [response.statusText, errorBody?.slice(0, 500)].filter(Boolean).join(': ');
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      const buf = await response.arrayBuffer();
      return new Uint8Array(buf);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}


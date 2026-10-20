/**
 * What an RPC failure is allowed to say in a log line.
 *
 * viem's `HttpRequestError.message` embeds the endpoint it was calling,
 * verbatim and in full:
 *
 *   HTTP request failed.
 *
 *   URL: https://eth-mainnet.g.alchemy.com/v2/<key>
 *   Request body: {"method":"eth_getLogs",...}
 *
 * That was already untidy when the endpoint was ours. It became a privacy
 * problem when users started supplying their own (config/custom-rpc.ts),
 * because these lines land in the debug ring buffer, which records at error
 * and warn level whether or not debug mode is on, and which the user can
 * export and send to us. The endpoint is theirs, and its path or query is
 * usually an API key.
 *
 * TRUNCATE AT THE FIRST LINE, do not rely on `shortMessage`. The first version
 * of this returned `shortMessage` and fell back to `.message`, on the
 * assumption that a non-viem error has no endpoint interpolated into it. That
 * assumption was wrong, and wrong for the DOMINANT path: the vendored SDK
 * wraps viem errors in its own plain Error subclasses
 * (`ContractReadError`, `GetBlockNumberError`, `WaitForReceiptError`) built as
 * `new ContractReadError(error.message)`. Those have no `shortMessage`, and
 * all but `EventReadError` drop `cause`, so the endpoint is both present and
 * unrecoverable-from-structure. Every SDK read failure - note discovery,
 * session init, per-chain sync - took that path (kimi, 2026-09-11).
 *
 * Line one survives both shapes, because both are built the same way: viem
 * puts its summary on line 1 and `URL:`/`Request body:` on later lines, and
 * the SDK's wrapper prefixes that same string. So line 1 is
 * "HTTP request failed." or "Contract read failed: HTTP request failed." and
 * the endpoint is always below it.
 */

type MaybeViemError = { shortMessage?: unknown; cause?: unknown };

/** viem's own one-line summary, from the error or anything it wrapped. */
function shortMessageOf(err: unknown, depth = 0): string | undefined {
  if (depth > 4 || err === null || typeof err !== 'object') return undefined;
  const candidate = err as MaybeViemError;
  const short = candidate.shortMessage;
  if (typeof short === 'string' && short.length > 0) return short;
  return shortMessageOf(candidate.cause, depth + 1);
}

/**
 * Take the URL out of whatever is left.
 *
 * Truncating to line 1 handles viem and the SDK's wrappers, because both put
 * the endpoint on a later line. It does NOTHING for an error whose one and
 * only line contains a URL - `new Error(\`fetch failed for ${url}\`)` - and
 * this module's promise is "no endpoint reaches the log", not "no endpoint
 * reaches the log from line two onwards". So the last step is unconditional.
 */
function stripUrls(line: string): string {
  return line.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<endpoint>');
}

export function describeRpcError(err: unknown): string {
  const short = shortMessageOf(err);
  const line = short !== undefined
    ? short.split('\n', 1)[0]
    // Everything viem appends after its summary - the URL, the request body,
    // the headers - is on a later line.
    : (err instanceof Error ? err.message : String(err)).split('\n', 1)[0];
  return stripUrls(line ?? '') || 'RPC request failed';
}

/**
 * Stack FRAMES only, never the header line.
 *
 * `Error.stack` starts with `Name: <the entire multi-line message>`, so
 * logging a stack logs the URL and the request body too. The frames
 * underneath are the part that was actually wanted.
 */
export function describeErrorFrames(err: unknown): string | undefined {
  const stack = err instanceof Error ? err.stack : undefined;
  if (!stack) return undefined;
  const frames = stack
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, 12)
    .map((line) => line.trim());
  return frames.length > 0 ? frames.join(' | ') : undefined;
}

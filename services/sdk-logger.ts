/**
 * Console-forwarding logger for the SDK's PoolSession (its `ILogger`).
 *
 * Until now the app built every PoolSession WITHOUT a logger, so the SDK's own
 * diagnostics never reached the console: "Error getting note events from ASP",
 * "Commitments without an on-chain timestamp; retrying next scan", the RPC
 * gap-fill decisions. Debugging recipient-side discovery (2026-08-25: notes
 * that decrypt offline never appeared in the browser) meant guessing.
 *
 * Warnings and errors always forward, prefixed `[SDK/<service>]` so the e2e
 * console filter and the in-app debug panel pick them up. Info/debug forward
 * only when the debug flag is on (`ppv2_debug` in localStorage, the same
 * switch the app's own logger honours), because SDK debug is chatty.
 *
 * PURE module (no react-native imports).
 */

type SdkLogger = {
  level: string;
  child: (service: string) => SdkLogger;
  debug: (msg: string, obj?: object) => void;
  info: (msg: string, obj?: object) => void;
  warn: (msg: string, obj?: object) => void;
  error: (msg: string, obj?: object) => void;
  fatal: (msg: string, obj?: object) => void;
};

function debugEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('ppv2_debug') === '1';
  } catch {
    return false;
  }
}

/** Trim structured context so a single line cannot flood the console. */
function compact(obj: object | undefined): string {
  if (!obj) return '';
  try {
    const s = JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    return s.length > 600 ? `${s.slice(0, 600)}…` : s;
  } catch {
    return '[unserializable]';
  }
}

export function createSdkConsoleLogger(service = 'SDK'): SdkLogger {
  const tag = service === 'SDK' ? '[SDK]' : `[SDK/${service}]`;
  return {
    level: debugEnabled() ? 'debug' : 'warn',
    child: (child: string) => createSdkConsoleLogger(service === 'SDK' ? child : `${service}/${child}`),
    debug: (msg, obj) => { if (debugEnabled()) console.debug(`${tag} ${msg}`, compact(obj)); },
    info: (msg, obj) => { if (debugEnabled()) console.info(`${tag} ${msg}`, compact(obj)); },
    warn: (msg, obj) => console.warn(`${tag} ${msg}`, compact(obj)),
    error: (msg, obj) => console.error(`${tag} ${msg}`, compact(obj)),
    fatal: (msg, obj) => console.error(`${tag} FATAL ${msg}`, compact(obj)),
  };
}

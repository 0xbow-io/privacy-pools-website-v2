/**
 * Route this app's RPC calls over Tor - PURE module (no react-native imports;
 * browser globals only behind guards) so bun tests can import it.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT.
 *
 * A browser cannot open a raw TCP socket, so nothing in a web page can speak to
 * a Tor relay directly. tor-js works around that with a GATEWAY: the page
 * reaches it over WebRTC and the gateway opens the relay connections on the
 * page's behalf. Tor's own layered encryption still applies end to end, so the
 * gateway does not see the request or its destination, but it DOES see that
 * this browser is connecting and from where. That is a real trust boundary,
 * which is why using one is a decision the user makes rather than a default
 * that happens to them.
 *
 * THERE IS NO BUNDLED GATEWAY. tor-js documents `gateway` as "Required in
 * browsers for relay connections" and ships no address: what it defaults is the
 * WebRTC/QUIC dialer, three fields further down in its options, which is easy
 * to misread as a default gateway. The addresses in its README (198.51.100.7,
 * 203.0.113.4) are RFC 5737 documentation ranges and do not route.
 *
 * So a suggested gateway has to come from us, through EXPO_PUBLIC_TOR_GATEWAY.
 * When that is set the form offers it prefilled and the user must tick a second
 * box to accept it, because a gateway nobody chose is the one thing this
 * setting must not have. When it is unset the field is simply the user's to
 * fill, which is the state this ships in until a gateway exists to point at.
 *
 * INDEPENDENT OF THE CUSTOM RPC SETTING, deliberately. Tor changes HOW the
 * request travels; a custom endpoint changes WHERE it goes. Turning Tor on with
 * no custom endpoint is a supported and sensible combination: our own Alchemy
 * endpoints, reached over Tor, so the provider serves the call without learning
 * the address it came from.
 *
 * MATURITY. tor-js describes itself as experimental, ships no trust model, and
 * has almost no users. Treat this as an option for someone who has decided they
 * want it, not as a promise the app makes.
 *
 * THROUGH ANON-RPC. The client is not ours: services/tor-fetch.ts runs it as an
 * anon-rpc worker (https://github.com/ethereum/anon-rpc), a bundle pinned by
 * hash on an on-chain specifier contract and run in a null-origin sandbox. A
 * provider is one such specifier: tor-js, Nym and Nox are the anonymizing ones
 * the harness lists as known workers. Only tor-js takes a gateway; Nym and
 * Nox carry their own way in and take no config.
 *
 * Resolved ONCE at module load, like config/custom-rpc.ts, because the wagmi
 * transports and the SDK session are built from it once per page load.
 */

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * On Android and iOS the client is Arti compiled into the app, which dials Tor
 * relays over TCP itself: there is no gateway to name, and no specifier to
 * read. Detected without importing react-native, which bun tests cannot load.
 */
const IS_REACT_NATIVE = typeof navigator !== 'undefined'
  && (navigator as { product?: string }).product === 'ReactNative';

function nativePlatform(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('react-native') as typeof import('react-native')).Platform.OS;
  } catch {
    return undefined;
  }
}

const ON_DEVICE_PLATFORMS = new Set(['android', 'ios']);

export const TOR_ON_DEVICE: boolean = IS_REACT_NATIVE && ON_DEVICE_PLATFORMS.has(nativePlatform() ?? '');

export const TOR_STORAGE_KEY = 'ppv2_tor_v1';

export type TorProviderId = 'tor-js' | 'nym' | 'nox';

export type TorProvider = {
  /**
   * The harness's known-worker name, which supplies the specifier contract and
   * the chain it is published on (knownWorker() in the browser harness).
   */
  id: TorProviderId;
  label: string;
  /**
   * The bundle hash this build accepts. The specifier is read over an RPC, and
   * the harness runs whatever hash that read returns; pinning it here means an
   * endpoint that lies cannot choose the code. A new client version on-chain
   * turns Tor off until this is updated, which is the intended failure.
   */
  workerHash: `0x${string}`;
  /**
   * Whether the user must name a gateway. Only tor-js does: a browser cannot
   * open TCP, so it dials Tor through one. The gateway field, its validation
   * and the suggested-gateway tick apply to these providers alone.
   */
  needsGateway: boolean;
  /**
   * Web only. A device runs Arti, not anon-rpc, so a provider without a native
   * client is hidden there and a saved choice naming it reads as off.
   */
  webOnly: boolean;
  /** One line for the (i) beside the picker. No em dashes. */
  hint: string;
  /**
   * The worker's own config (anon-rpc §7.1). tor-js takes the user's gateway;
   * the others take none, which the harness passes as undefined, as the
   * anon-rpc demo does for an entry without an exampleConfig.
   */
  workerConfig: (gatewayUrl: string) => unknown;
};

/**
 * The harness's known workers that anonymize. The passthrough reference worker
 * is left out on purpose: it sends with a plain fetch and anonymizes nothing.
 */
export const TOR_PROVIDERS: readonly TorProvider[] = ([
  {
    // The id stays tor-js on a device, where saved settings name it, but the
    // client there is Arti, so the label names the network instead.
    id: 'tor-js',
    label: TOR_ON_DEVICE ? 'Tor' : 'tor-js',
    // tor-js 0.4.3, as the specifier named it on 2026-10-07 (verified 2026-10-15:
    // same owner, bundle keccak matches on all three resolvers).
    workerHash: '0xe39f8c42ed72b7f580a73c46c3300f6d3ad3954bbc26e5fe075b18c48fedc8b5',
    needsGateway: true,
    webOnly: false,
    hint: 'Tor, run in your browser. It connects through a gateway, which sees that you connected but not what you asked for.',
    workerConfig: (gatewayUrl) => ({ gateways: [gatewayUrl] }),
  },
  {
    id: 'nym',
    label: 'Nym',
    // As the specifier named it on 2026-10-15.
    workerHash: '0xf13a448a8721b9d0b20da3d5b80ffe00bf4c5bb3aae812a38d3d1e3bc81fceb8',
    needsGateway: false,
    webOnly: true,
    hint: 'The Nym mixnet. Calls leave from a Nym exit, so the endpoint never sees your address. About 18 MB to download.',
    workerConfig: () => undefined,
  },
  {
    id: 'nox',
    label: 'Nox (demo)',
    // As the specifier named it on 2026-10-15.
    workerHash: '0xd8bef626ec8511d7a468bca5137880680ca2da20d2ea4d9c981a2a3d0c86ba1e',
    needsGateway: false,
    webOnly: true,
    hint: 'A Sphinx mixnet. This is a demo network: it may be slow or go away.',
    workerConfig: () => undefined,
  },
] satisfies TorProvider[]).filter((provider) => !(TOR_ON_DEVICE && provider.webOnly));

export const DEFAULT_TOR_PROVIDER: TorProviderId = 'tor-js';

export function torProvider(id: string): TorProvider | undefined {
  return TOR_PROVIDERS.find((provider) => provider.id === id);
}

/** Does this provider take a gateway? Unknown ids answer yes, the strict side. */
export function torNeedsGateway(id: string): boolean {
  return torProvider(id)?.needsGateway ?? true;
}

export type TorSettings = {
  enabled: boolean;
  /**
   * The user's gateway, for a provider that takes one. Empty means that
   * provider cannot run, whatever `enabled` says. Always empty otherwise.
   */
  gatewayUrl: string;
  provider: TorProviderId;
};

export const TOR_OFF: TorSettings = { enabled: false, gatewayUrl: '', provider: DEFAULT_TOR_PROVIDER };

export type TorRejection = 'empty' | 'unparseable' | 'proxy';

export type TorValidation =
  | { ok: true; url: string }
  | { ok: false; reason: TorRejection; message: string };

export const TOR_GATEWAY_MESSAGES: Record<TorRejection, string> = {
  empty: 'Enter your gateway address.',
  unparseable: 'Paste the gateway address in ip:port:certhash format (IPv6 addresses need brackets).',
  // Its own message because it is the mistake people actually make. Running a
  // local Tor and pasting what it prints is the obvious move, and the format
  // error alone does not explain why the obvious move is wrong.
  proxy: 'That is a proxy address, which a web page cannot open. Run the tor-js gateway and paste the ip:port:certhash it prints, or point your whole browser at your proxy instead.',
};

/**
 * tor-js 0.4.1 dials KPS, not an HTTP or WebSocket URL. Keep this small parser
 * local so opening the form does not import the Tor client just to validate it.
 * The certificate hash pins the gateway's WebRTC certificate.
 */
export function validateTorGateway(value: string): TorValidation {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, reason: 'empty', message: TOR_GATEWAY_MESSAGES.empty };
  const invalid: TorValidation = { ok: false, reason: 'unparseable', message: TOR_GATEWAY_MESSAGES.unparseable };
  // A scheme means they pasted a proxy or a URL. Arti prints
  // socks5h://127.0.0.1:9150 and a browser cannot dial SOCKS from a page:
  // fetch, WebSocket and WebRTC are all it has, and none of them speak it.
  // That gap is the entire reason tor-js needs a gateway rather than talking
  // to a local Tor (Pat, 2026-09-22, running Arti).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return { ok: false, reason: 'proxy', message: TOR_GATEWAY_MESSAGES.proxy };
  }
  const match = /^(\[[0-9a-fA-F:.]+\]|[0-9.]+):(\d+):(u[A-Za-z0-9_-]{46})$/.exec(trimmed);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return invalid;
  const [, host, , hash] = match;
  if (host.startsWith('[')) {
    try { new URL(`https://${host}/`); } catch { return invalid; }
  } else if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.split('.').some((part) => Number(part) > 255)) {
    return invalid;
  }
  try {
    const bytes = atob(hash.slice(1).replace(/-/g, '+').replace(/_/g, '/'));
    if (bytes.length !== 34 || bytes.charCodeAt(0) !== 0x12 || bytes.charCodeAt(1) !== 0x20) return invalid;
  } catch {
    return invalid;
  }
  return { ok: true, url: trimmed };
}

/**
 * The gateway check for a provider: tor-js validates the address, a provider
 * that takes none accepts anything and stores an empty gateway.
 */
export function validateTorGatewayFor(providerId: string, value: string): TorValidation {
  if (TOR_ON_DEVICE || !torNeedsGateway(providerId)) return { ok: true, url: '' };
  return validateTorGateway(value);
}

/**
 * Empty by default; a mistyped deployment value must not become a suggestion.
 * Validation reads the message table, so this must follow its initialization.
 */
export const SUGGESTED_TOR_GATEWAY: string = (() => {
  const raw = process.env.EXPO_PUBLIC_TOR_GATEWAY?.trim() ?? '';
  if (!raw) return '';
  return validateTorGateway(raw).ok ? raw : '';
})();

/**
 * Parse stored settings, refusing anything the form would have.
 *
 * A tampered or stale entry must not switch Tor on with a gateway this build
 * would reject, so the gateway goes back through the validator on every read.
 */
export function parseTorSettings(raw: string | null): TorSettings {
  if (!raw) return TOR_OFF;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return TOR_OFF;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return TOR_OFF;

  const record = parsed as Record<string, unknown>;
  // Entries written before providers existed carry none, and meant tor-js.
  // A named provider this build does not know (or one hidden on this
  // platform) turns it off rather than quietly running a different client.
  const provider = record.provider === undefined ? DEFAULT_TOR_PROVIDER
    : typeof record.provider === 'string' ? torProvider(record.provider)?.id : undefined;
  if (!provider) return TOR_OFF;
  if (!torNeedsGateway(provider) || TOR_ON_DEVICE) {
    // No gateway to keep. One that is there anyway (a device entry is empty)
    // is not carried, so switching back to tor-js asks for it again.
    if (TOR_ON_DEVICE && record.gatewayUrl) {
      const gateway = typeof record.gatewayUrl === 'string' ? validateTorGateway(record.gatewayUrl) : null;
      if (!gateway?.ok) return TOR_OFF;
      return { enabled: record.enabled === true, gatewayUrl: gateway.url, provider };
    }
    return { enabled: record.enabled === true, gatewayUrl: '', provider };
  }
  const gateway = typeof record.gatewayUrl === 'string' ? validateTorGateway(record.gatewayUrl) : null;
  if (!gateway?.ok) return TOR_OFF;

  return { enabled: record.enabled === true, gatewayUrl: gateway.url, provider };
}

export function serializeTorSettings(settings: TorSettings): string {
  return JSON.stringify(settings);
}

/**
 * Is Tor actually going to run?
 *
 * Both halves are required. `enabled` alone is a ticked box with nowhere to
 * connect, and treating that as "on" would be the worst outcome available: the
 * user believes they are on Tor while every call goes out directly.
 */
export function torActive(settings: TorSettings): boolean {
  return settings.enabled === true && torProvider(settings.provider) !== undefined
    && validateTorGatewayFor(settings.provider, settings.gatewayUrl).ok;
}

export function readTorSettings(storage: StorageLike | null | undefined): TorSettings {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(TOR_STORAGE_KEY) ?? null;
  } catch {
    raw = null;
  }
  return parseTorSettings(raw);
}

/** A refused or invalid write must not be reported as a saved choice. */
export function writeTorSettings(storage: StorageLike | null | undefined, settings: TorSettings): boolean {
  if (!storage || (settings.enabled && !torActive(settings))) return false;
  try {
    if (!settings.enabled) storage.removeItem(TOR_STORAGE_KEY);
    else storage.setItem(TOR_STORAGE_KEY, serializeTorSettings(settings));
    return true;
  } catch {
    return false;
  }
}

/**
 * The device keeps the choice in SecureStore, whose getItem/setItem are
 * synchronous: the setting has to be known at module load, before the first
 * transport is built. Required lazily so web and bun never load the module.
 * SecureStore has no synchronous delete, so an empty value stands for none.
 */
function deviceStorage(): StorageLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const secure = require('expo-secure-store') as typeof import('expo-secure-store');
    return {
      getItem: (key) => secure.getItem(key) || null,
      setItem: (key, value) => secure.setItem(key, value),
      removeItem: (key) => secure.setItem(key, ''),
    };
  } catch {
    return null;
  }
}

function activeStorage(): StorageLike | null {
  if (TOR_ON_DEVICE) return deviceStorage();
  if (typeof window === 'undefined') return null;
  try {
    // Local only. A session-scoped Tor setting would silently lapse in a new
    // tab, which is the same failure as the ticked box with no gateway.
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Resolved once at module load; changing it requires a reload (by design). */
export const ACTIVE_TOR_SETTINGS: TorSettings = readTorSettings(activeStorage());

/** Is Tor in force for this page load? */
export const TOR_IN_FORCE: boolean = torActive(ACTIVE_TOR_SETTINGS);

export function saveTorSettings(settings: TorSettings): boolean {
  const storage = activeStorage();
  const stored = readTorSettings(storage);
  // A failed RPC save can leave Tor written without reloading. Compare storage
  // too, so retrying with the original choice does not retain that partial save.
  // The unchanged default still needs no localStorage write in a restricted tab.
  // Off is decided on the raw entry, not the parsed one: an entry this build
  // cannot read (an unknown provider) parses as off but must still be removed,
  // or a later build that knows the provider would switch it back on.
  if (!settings.enabled) {
    let raw: string | null = null;
    try {
      raw = storage?.getItem(TOR_STORAGE_KEY) ?? null;
    } catch {
      raw = null;
    }
    if (!raw && !ACTIVE_TOR_SETTINGS.enabled) return true;
    return writeTorSettings(storage, settings);
  }
  const same = (a: TorSettings) => settings.enabled === a.enabled && settings.gatewayUrl === a.gatewayUrl
    && settings.provider === a.provider;
  if (same(ACTIVE_TOR_SETTINGS) && same(stored)) return true;
  return writeTorSettings(storage, settings);
}

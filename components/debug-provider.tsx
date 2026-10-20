import { createContext, memo, useContext, useState, useCallback, useEffect, useMemo, useRef, ReactNode } from 'react';
import { Platform, View, Text, ScrollView, Pressable, TextInput, type TextStyle, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors } from '@/constants/theme';
import { ACTIVE_APP_ENVIRONMENT, appEnvironmentLabel } from '@/config/app-environment';
import { useTheme } from '@/components/theme-provider';
import { useToast } from '@/components/toast-provider';
import {
  describeCopiedLogs,
  filterDebugLogs,
  formatDebugLogCount,
  formatDebugLogs,
  formatDebugLogTime,
  isDebugLogFilterActive,
  debugLogPreview,
  expandedPayloadTokens,
  type PayloadToken,
  type PayloadTokenKind,
  type DebugLogEntry,
  type DebugLogLevel,
} from '@/services/debug-log-filter';
import { BoundedDebugLog, buildDebugRecording, debugRecordingFileName, RECORDING_SECRET_WARNING } from '@/services/debug-recording';
import { DEFAULT_REDACTION_LEVEL, REDACTION_LEVEL_INFO, REDACTION_LEVELS, type RedactionLevel } from '@/services/debug-redaction';
import { HoverHint } from '@/components/ui/hover-hint';
import { Pill } from '@/components/ui/pill';
import { collectDebugSnapshots } from '@/services/debug-snapshots';
import { installDebugCapture, uncaptured } from '@/services/debug-capture';

// The entry shape and everything that reads it (search, level filter, line
// serialisation) live in services/debug-log-filter.ts so CI actually runs
// them; these aliases keep the provider's own signatures unchanged.
type LogLevel = DebugLogLevel;

type LogEntry = DebugLogEntry;

type FinishedRecording = {
  startedAt: number;
  stoppedAt: number;
  entries: LogEntry[];
  truncated: boolean;
  atStart?: Record<string, unknown>;
  atStop?: Record<string, unknown>;
};

type DebugContextType = {
  isDebugEnabled: boolean;
  isOverlayVisible: boolean;
  log: (level: LogLevel, tag: string, message: string, data?: unknown) => void;
  getLogs: () => LogEntry[];
  clearLogs: () => void;
  exportLogs: () => string;
  toggleOverlay: () => void;
  /** A recording is running: every entry since Start is kept, uncapped by the ring buffer. */
  isRecording: boolean;
  startRecording: () => void;
  /** Ends the recording and hands back what it captured. */
  stopRecording: () => { entries: LogEntry[]; startedAt: number; stoppedAt: number };
  /** Everything since debug mode was turned on. */
  getSessionLog: () => { startedAt: number; entries: LogEntry[]; truncated: boolean } | null;
  /** When the running recording started (null while not recording). Kept here, not in the button, which remounts on every route. */
  recordingStartedAt: number | null;
  /** The last finished recording, if any. */
  getLastRecording: () => FinishedRecording | null;
  /** Opens the export dialog: everything since debug mode was on, or the last recording. */
  openExport: (preferred: 'session' | 'recording') => void;
};

const DebugContext = createContext<DebugContextType>({
  isDebugEnabled: false,
  isOverlayVisible: false,
  log: () => {},
  getLogs: () => [],
  clearLogs: () => {},
  exportLogs: () => '',
  toggleOverlay: () => {},
  isRecording: false,
  startRecording: () => {},
  stopRecording: () => ({ entries: [], startedAt: 0, stoppedAt: 0 }),
  getSessionLog: () => null,
  recordingStartedAt: null,
  getLastRecording: () => null,
  openExport: () => {},
});

const MAX_LOGS = 2000;
const HOTKEY_SEQUENCE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
const HOTKEY_TIMEOUT = 3000;
const DEBUG_STORAGE_KEY = 'ppv2_debug';
/** DOM id of the overlay's own search box, so the clickstream can skip it. */
const DEBUG_SEARCH_INPUT_ID = 'ppv2-debug-search';
/**
 * Prefix for the `nativeID` of an input whose VALUE must never be recorded.
 * The clickstream logs every other field edit, and the log can be exported, so
 * a field holding a user secret (a custom RPC endpoint, which often carries the
 * provider's API key) opts out by naming itself with this prefix.
 */
export const SENSITIVE_INPUT_ID_PREFIX = 'ppv2-sensitive-';

/**
 * Non-hook debug check for code that mounts ABOVE DebugProvider (e.g.
 * ChainProvider). Mirrors the provider's own web activation signals
 * (?debug=1 query param or the persisted localStorage flag).
 */
export function isDebugModeActive(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('debug') === '1') return true;
    return localStorage.getItem(DEBUG_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function DebugProvider({ children }: { children: ReactNode }) {
  const [isDebugEnabled, setIsDebugEnabled] = useState(false);
  const [isOverlayVisible, setIsOverlayVisible] = useState(false);
  // Debug mode carried in on page load (?debug=1 or the stored flag) opens the
  // panel as a header bar so it does not cover the page; opening it on purpose
  // (the hotkey, __ppv2Debug.enable) opens it full height.
  const [isOverlayCollapsed, setIsOverlayCollapsed] = useState(false);
  const logs = useRef<LogEntry[]>([]);
  const keySequence = useRef<string[]>([]);
  const lastKeyTime = useRef(0);
  // The recording's own copy: the ring buffer above drops old entries, and a
  // long manual run is exactly what outgrows it.
  const [isRecording, setIsRecording] = useState(false);
  const recording = useRef<{ startedAt: number; log: BoundedDebugLog; atStart?: Record<string, unknown> } | null>(null);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  // Everything since debug mode was turned on, also past the ring buffer: the
  // other choice in the export dialog (Pat, 2026-09-24).
  const session = useRef<{ startedAt: number; log: BoundedDebugLog } | null>(null);
  // The last finished recording, kept so the export dialog can offer it.
  const lastRecording = useRef<FinishedRecording | null>(null);
  const [exportOpen, setExportOpen] = useState<null | 'session' | 'recording'>(null);

  const log = useCallback((level: LogLevel, tag: string, message: string, data?: unknown) => {
    const entry: LogEntry = { timestamp: Date.now(), level, tag, message, data };
    logs.current.push(entry);
    // Bounded by entries AND bytes (services/debug-recording.ts).
    recording.current?.log.push(entry);
    session.current?.log.push(entry);
    if (logs.current.length > MAX_LOGS) {
      logs.current = logs.current.slice(-MAX_LOGS);
    }
    // Entries that CAME from the console or the network capture are already in
    // devtools (or are request lines): echoing them doubled every line.
    if (isDebugEnabled && tag !== 'console' && tag !== 'net') {
      const prefix = `[${level.toUpperCase()}][${tag}]`;
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      uncaptured(() => fn(prefix, message, data !== undefined ? data : ''));
    }
  }, [isDebugEnabled]);

  const getLogs = useCallback(() => [...logs.current], []);

  const clearLogs = useCallback(() => {
    logs.current = [];
  }, []);

  /** The WHOLE buffer, filters ignored. `save` is the full-record control. */
  const exportLogs = useCallback(() => formatDebugLogs(logs.current), []);

  const toggleOverlay = useCallback(() => {
    setIsOverlayVisible((v) => !v);
    setIsOverlayCollapsed(false);
  }, []);

  const startRecording = useCallback(() => {
    const t0 = Date.now();
    recording.current = { startedAt: t0, log: new BoundedDebugLog('stop'), atStart: collectDebugSnapshots() };
    setRecordingStartedAt(t0);
    setIsRecording(true);
    log('info', 'debug', 'Recording started');
  }, [log]);

  const stopRecording = useCallback(() => {
    log('info', 'debug', 'Recording stopped');
    const rec = recording.current;
    recording.current = null;
    setIsRecording(false);
    setRecordingStartedAt(null);
    const done: FinishedRecording = {
      entries: rec?.log.entries ?? [],
      truncated: rec?.log.truncated ?? false,
      startedAt: rec?.startedAt ?? Date.now(),
      stoppedAt: Date.now(),
      atStart: rec?.atStart,
      atStop: collectDebugSnapshots(),
    };
    lastRecording.current = done;
    // Stop asks what to save (Pat, 2026-09-24).
    setExportOpen('recording');
    return done;
  }, [log]);

  const getSessionLog = useCallback(() => {
    const ses = session.current;
    return ses ? { startedAt: ses.startedAt, entries: ses.log.entries, truncated: ses.log.truncated } : null;
  }, []);
  const openExport = useCallback((preferred: 'session' | 'recording') => setExportOpen(preferred), []);
  const getLastRecording = useCallback(() => lastRecording.current, []);

  // While debug mode is on: the session log starts, and console lines, uncaught
  // errors and every network request are captured (services/debug-capture.ts).
  useEffect(() => {
    if (!isDebugEnabled || Platform.OS !== 'web') return;
    const ses = { startedAt: Date.now(), log: new BoundedDebugLog('drop-oldest') };
    for (const e of logs.current) ses.log.push(e);
    session.current = ses;
    const uninstall = installDebugCapture(log);
    return () => {
      uninstall();
      session.current = null;
      // Debug off mid-recording: the button and dialog are gone, so the
      // recording must not keep appending unseen.
      recording.current = null;
      setIsRecording(false);
      setRecordingStartedAt(null);
    };
  }, [isDebugEnabled, log]);

  /**
   * Clickstream: every press and every field edit, with timings.
   *
   * This is what makes a manual run comparable to an automated one. A flow that
   * works by hand and fails in the e2e differs in WHAT was pressed and WHEN, not
   * usually in the protocol internals, and reconstructing that from memory (or
   * from a screenshot) does not work. Each line carries the visible label, the
   * pressable's box, the time since page load and the gap since the previous
   * interaction, so two runs can be diffed line by line.
   *
   * Capture phase, so it still records a press that a handler later swallows.
   * Field values are truncated: an address is public, a long paste is noise.
   */
  const lastInteractionRef = useRef(0);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;

    const describe = (node: EventTarget | null): { label: string; box: string } => {
      let el = node instanceof HTMLElement ? node : null;
      if (!el) return { label: '(unknown)', box: '' };
      // Walk up to the pressable: these CTAs are RN-Web divs whose own text node
      // carries the pointer cursor, so the deepest target is rarely the button.
      let pressable = el;
      for (let up = 0; up < 6 && el; up += 1) {
        if (getComputedStyle(el).cursor === 'pointer') { pressable = el; break; }
        el = el.parentElement;
      }
      const text = (pressable.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48);
      const r = pressable.getBoundingClientRect();
      return { label: text || '(no label)', box: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` };
    };

    const stamp = () => {
      const now = Math.round(performance.now());
      const since = lastInteractionRef.current ? now - lastInteractionRef.current : 0;
      lastInteractionRef.current = now;
      return { atMs: now, sincePrevMs: since };
    };

    const onPointerDown = (e: Event) => {
      const { label, box } = describe(e.target);
      log('info', 'UI', `press "${label}"`, { box, ...stamp() });
    };
    const onChange = (e: Event) => {
      const el = e.target as HTMLInputElement | null;
      if (!el || el.tagName !== 'INPUT') return;
      // The console's own search box is exempt: recording its value would add
      // a row that then MATCHES the query being typed, so every search would
      // return at least one hit about itself.
      if (el.id === DEBUG_SEARCH_INPUT_ID) return;
      // Fields whose VALUE is a user secret keep their interaction in the
      // clickstream (the timing is what makes a run comparable) but never
      // their contents: the log is a ring buffer the user can export and
      // send to us. Mark such an input with nativeID={SENSITIVE_INPUT_ID_PREFIX + '…'}.
      const sensitive = el.id.startsWith(SENSITIVE_INPUT_ID_PREFIX);
      const value = sensitive ? '(hidden)' : (el.value || '').slice(0, 60);
      log('info', 'UI', `input "${el.placeholder || '(no placeholder)'}"`, { value, ...stamp() });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'Escape') log('info', 'UI', `key ${e.key}`, stamp());
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [log]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    try {
      const params = new URLSearchParams(window.location.search);
      const queryEnabled = params.get('debug') === '1';
      const storedEnabled = localStorage.getItem(DEBUG_STORAGE_KEY) === '1';
      if (queryEnabled || storedEnabled) {
        // Persist query-param activation so every debug reader (this provider
        // AND the non-hook isDebugModeActive(), which the Sui chain gate uses)
        // agrees on ONE source of truth — otherwise dropping ?debug=1 via SPA
        // navigation would leave the provider enabled while the gate reads
        // false (visible-but-unselectable Sui). __ppv2Debug.disable() clears it.
        if (queryEnabled && !storedEnabled) {
          localStorage.setItem(DEBUG_STORAGE_KEY, '1');
        }
        setIsDebugEnabled(true);
        setIsOverlayVisible(true);
        setIsOverlayCollapsed(true);
      }

      (window as typeof window & {
        __ppv2Debug?: { enable: () => void; disable: () => void; toggle: () => void };
      }).__ppv2Debug = {
        enable: () => {
          localStorage.setItem(DEBUG_STORAGE_KEY, '1');
          setIsDebugEnabled(true);
          setIsOverlayVisible(true);
          setIsOverlayCollapsed(false);
        },
        disable: () => {
          localStorage.removeItem(DEBUG_STORAGE_KEY);
          setIsDebugEnabled(false);
          setIsOverlayVisible(false);
        },
        toggle: () => {
          const next = localStorage.getItem(DEBUG_STORAGE_KEY) !== '1';
          if (next) {
            localStorage.setItem(DEBUG_STORAGE_KEY, '1');
          } else {
            localStorage.removeItem(DEBUG_STORAGE_KEY);
          }
          setIsDebugEnabled(next);
          setIsOverlayVisible(next);
          setIsOverlayCollapsed(false);
        },
      };
    } catch {
      // Ignore browser storage / location failures.
    }
  }, []);

  // Hotkey detection (web only)
  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const now = Date.now();
      if (now - lastKeyTime.current > HOTKEY_TIMEOUT) {
        keySequence.current = [];
      }
      lastKeyTime.current = now;
      keySequence.current.push(e.key);

      if (keySequence.current.length > HOTKEY_SEQUENCE.length) {
        keySequence.current = keySequence.current.slice(-HOTKEY_SEQUENCE.length);
      }

      if (
        keySequence.current.length === HOTKEY_SEQUENCE.length &&
        keySequence.current.every((k, i) => k === HOTKEY_SEQUENCE[i])
      ) {
        keySequence.current = [];
        setIsDebugEnabled((prev) => {
          const next = !prev;
          try {
            if (next) localStorage.setItem(DEBUG_STORAGE_KEY, '1');
            else localStorage.removeItem(DEBUG_STORAGE_KEY);
          } catch {
            // Ignore storage errors.
          }
          setIsOverlayVisible(next);
          setIsOverlayCollapsed(false);
          return next;
        });
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <DebugContext.Provider
      value={{ isDebugEnabled, isOverlayVisible, log, getLogs, clearLogs, exportLogs, toggleOverlay, isRecording, recordingStartedAt, startRecording, stopRecording, getSessionLog, getLastRecording, openExport }}
    >
      {children}
      {isDebugEnabled && isOverlayVisible && (
        <DebugOverlay collapsed={isOverlayCollapsed} onToggleCollapsed={() => setIsOverlayCollapsed((c) => !c)} />
      )}
      {isDebugEnabled && exportOpen && <DebugExportDialog preferred={exportOpen} onClose={() => setExportOpen(null)} />}
    </DebugContext.Provider>
  );
}

export function useDebug() {
  return useContext(DebugContext);
}

/**
 * Record button for debug mode, in the header next to the Actions menu (Pat,
 * 2026-09-24). A dark dot while idle, red while recording. Stop asks whether to
 * save the recording as a JSON file (services/debug-recording.ts). Web only,
 * like the rest of debug mode.
 */
export function DebugRecordButton() {
  const { isDebugEnabled, isRecording, recordingStartedAt, startRecording, stopRecording } = useDebug();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRecording) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRecording]);
  const elapsed = isRecording && recordingStartedAt !== null && now > recordingStartedAt
    ? Math.floor((now - recordingStartedAt) / 1000)
    : 0;

  if (!isDebugEnabled || Platform.OS !== 'web') return null;

  const onPress = () => {
    if (isRecording) {
      // Opens the export dialog on the recording.
      stopRecording();
      return;
    }
    setNow(Date.now());
    startRecording();
  };

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  return (
    <Pressable
      onPress={onPress}
      testID="debug-record-button"
      accessibilityRole="button"
      accessibilityLabel={isRecording ? 'Stop recording' : 'Start recording'}
      className={`h-[32px] flex-row items-center gap-[6px] rounded-pill border px-[10px] ${isRecording ? 'border-[#EF4444] bg-[rgba(239,68,68,0.12)]' : 'border-border bg-[#FFFFFF]'}`}
    >
      {/* nw-keep(data-color): fixed record-dot colors, readable on both themes (white chip when idle) */}
      <View className="h-[12px] w-[12px] rounded-full" style={{ backgroundColor: isRecording ? '#EF4444' : '#111111' }} />
      <Text className={`font-pp-sans-medium text-[12px] ${isRecording ? 'text-[#EF4444]' : 'text-[#111111]'}`}>
        {isRecording ? `REC ${mm}:${ss}` : 'REC'}
      </Text>
    </Pressable>
  );
}

function downloadJson(json: string, name: string) {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function ExportChoice({ label, detail, onPress, disabled, primary, testID }: { label: string; detail: string; onPress: () => void; disabled?: boolean; primary?: boolean; testID: string }) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      testID={testID}
      className={`gap-[2px] rounded-control border px-[12px] py-[10px] ${primary ? 'border-button-primary' : 'border-border-light'} ${disabled ? 'opacity-40' : ''}`}
    >
      <Text className="font-pp-sans-medium text-[13px] text-text">{label}</Text>
      <Text className="font-pp-sans text-[11px] text-text-secondary">{detail}</Text>
    </Pressable>
  );
}

/**
 * One redaction level (services/debug-redaction.ts): a radio row with its
 * hint, and what the file still holds behind the (i).
 */
function RedactionChoice({ level, selected, onSelect }: { level: RedactionLevel; selected: boolean; onSelect: () => void }) {
  const info = REDACTION_LEVEL_INFO[level];
  return (
    <View className="flex-row items-center gap-[8px]">
      <Pressable
        onPress={onSelect}
        accessibilityRole="radio"
        accessibilityState={{ checked: selected }}
        testID={`debug-redaction-${level}`}
        className="min-w-0 flex-1 flex-row items-center gap-[8px] py-[2px]"
      >
        <View className={`h-[14px] w-[14px] items-center justify-center rounded-full border ${selected ? 'border-button-primary' : 'border-border'}`}>
          {selected && <View className="h-[8px] w-[8px] rounded-full bg-button-primary" />}
        </View>
        <Text className="font-pp-sans-medium text-[12px] text-text">{info.label}</Text>
        <Text className="min-w-0 shrink font-pp-sans text-[11px] text-text-secondary" numberOfLines={1}>{info.hint}</Text>
      </Pressable>
      <HoverHint hint={info.keeps}>
        <Text className="font-pp-sans text-[11px] text-text-secondary">(i)</Text>
      </HoverHint>
    </View>
  );
}

/**
 * What to export: everything since debug mode was turned on, or only the last
 * recording (Pat, 2026-09-24). Both are the same JSON shape
 * (services/debug-recording.ts) with the app state snapshots. How much is
 * removed is the user's pick (Pat, 2026-09-25): spending keys by default, and
 * the spend-grade warning only when they choose Full.
 */
function DebugExportDialog({ preferred, onClose }: { preferred: 'session' | 'recording'; onClose: () => void }) {
  const { getSessionLog, getLastRecording, log, isRecording } = useDebug();
  const [level, setLevel] = useState<RedactionLevel>(DEFAULT_REDACTION_LEVEL);
  const sessionLog = getSessionLog();
  const rec = getLastRecording();
  const meta = () => ({
    environment: appEnvironmentLabel(ACTIVE_APP_ENVIRONMENT),
    url: typeof window !== 'undefined' ? window.location.origin + window.location.pathname : undefined,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
  });
  const exportSession = () => {
    if (!sessionLog) return;
    const stoppedAt = Date.now();
    downloadJson(
      buildDebugRecording(sessionLog.entries, { ...meta(), startedAt: sessionLog.startedAt, stoppedAt, truncated: sessionLog.truncated, snapshots: { atStop: collectDebugSnapshots() } }, level),
      debugRecordingFileName(sessionLog.startedAt, level).replace('ppv2-recording-', 'ppv2-debug-session-'),
    );
    log('info', 'debug', `Exported everything since debug mode was turned on (${level})`);
    onClose();
  };
  const exportRecording = () => {
    if (!rec) return;
    downloadJson(
      buildDebugRecording(rec.entries, { ...meta(), startedAt: rec.startedAt, stoppedAt: rec.stoppedAt, truncated: rec.truncated, snapshots: { atStart: rec.atStart, atStop: rec.atStop } }, level),
      debugRecordingFileName(rec.startedAt, level),
    );
    log('info', 'debug', `Exported the recording (${level})`);
    onClose();
  };
  return (
    <View className="absolute inset-0 z-[999999] items-center justify-center bg-[rgba(0,0,0,0.5)] px-[16px]" testID="debug-export-dialog">
      <View className="w-full max-w-[380px] gap-[10px] rounded-card border border-border-light bg-card-background p-[16px]">
        <Text className="font-pp-bold text-[15px] text-text">Export debug log</Text>
        <View className="gap-[4px]" accessibilityRole="radiogroup" testID="debug-redaction-levels">
          <Text className="font-pp-sans-medium text-[12px] text-text-secondary">What to remove</Text>
          {REDACTION_LEVELS.map((l) => (
            <RedactionChoice key={l} level={l} selected={level === l} onSelect={() => setLevel(l)} />
          ))}
        </View>
        {level === 'full' && (
          <Text className="font-pp-sans text-[11px] leading-[15px] text-[#EF4444]">{RECORDING_SECRET_WARNING}</Text>
        )}
        <ExportChoice
          label="Everything since debug mode was turned on"
          detail={sessionLog ? `${sessionLog.entries.length} entries` : 'Nothing captured yet'}
          onPress={exportSession}
          disabled={!sessionLog}
          primary={preferred === 'session'}
          testID="debug-export-session"
        />
        <ExportChoice
          label="This recording only"
          detail={isRecording
            ? 'Recording in progress. Stop it first.'
            : rec ? `${rec.entries.length} entries` : 'No recording yet. Press REC in the header.'}
          onPress={exportRecording}
          disabled={!rec || isRecording}
          primary={preferred === 'recording'}
          testID="debug-export-recording"
        />
        <Pressable onPress={onClose} className="self-end rounded-control px-[10px] py-[5px]" testID="debug-export-cancel">
          <Text className="font-pp-sans-medium text-[12px] text-text-secondary">Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The panel floats over the page, so it sits on the floating-menu surface with
 * an upward shadow to read as a separate layer in both themes. Dark needs the
 * heavier shadow: a light one disappears against a near-black page.
 */
function debugPanelShadow(colorScheme: 'light' | 'dark'): ViewStyle {
  const opacity = colorScheme === 'dark' ? 0.6 : 0.12;
  return Platform.OS === 'web'
    ? ({ boxShadow: `0px -4px 16px rgba(0, 0, 0, ${opacity})` } as ViewStyle)
    : { elevation: 16, shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: opacity, shadowRadius: 16 };
}

/**
 * Log text is monospaced so the columns line up and hex strings read character
 * by character. The app's own face has no monospaced cut, so this is the
 * platform's system mono.
 */
const LOG_MONO: TextStyle = {
  fontFamily: Platform.select({
    web: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    ios: 'Menlo',
    default: 'monospace',
  }),
};
/** Expanded payloads are mostly JSON full of unbroken hex, which only wraps if any character may break. */
const LOG_PAYLOAD: TextStyle = Platform.OS === 'web'
  ? ({ ...LOG_MONO, wordBreak: 'break-all' } as TextStyle)
  : LOG_MONO;

/**
 * Severity follows the browser console: debug is dimmed, info is plain, warn
 * and error tint the row and carry an icon. Theme tokens, so both themes read.
 */
const LEVEL_STYLE: Record<LogLevel, { row: string; text: string; icon?: 'warning' | 'close-circle' }> = {
  debug: { row: '', text: 'text-text-muted' },
  info: { row: '', text: 'text-text' },
  warn: { row: 'bg-warning-bg', text: 'text-warning', icon: 'warning' },
  error: { row: 'bg-danger-bg', text: 'text-danger', icon: 'close-circle' },
};

/** Payload colours from the Chrome DevTools console, light and dark. */
const PAYLOAD_COLORS: Record<'light' | 'dark', Record<Exclude<PayloadTokenKind, 'text' | 'punctuation'>, string>> = {
  light: { key: '#5F6368', string: '#C41A16', number: '#1A1AA6', literal: '#1A1AA6', nullish: '#80868B' },
  dark: { key: '#BDC1C6', string: '#5CD5FB', number: '#9980FF', literal: '#9980FF', nullish: '#9AA0A6' },
};

function PayloadText({ tokens, colorScheme }: { tokens: PayloadToken[]; colorScheme: 'light' | 'dark' }) {
  return tokens.map((token, i) => (
    token.kind === 'text' || token.kind === 'punctuation'
      ? token.text
      // nw-keep(data-color): console syntax colour per payload token kind, per theme
      : <Text key={i} style={{ color: PAYLOAD_COLORS[colorScheme][token.kind] }}>{token.text}</Text>
  ));
}

/**
 * One console entry, laid out like the browser console: the message on the
 * first line with its tag where the console puts the source link, then the
 * payload preview under a disclosure arrow that expands it in full.
 */
// Memoised: the panel redraws every second, and an unchanged row (same entry,
// same expanded state) has nothing to redraw.
const DebugLogRow = memo(function DebugLogRow({ entry, expanded, onToggle, colorScheme }: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: (entry: LogEntry) => void;
  colorScheme: 'light' | 'dark';
}) {
  const style = LEVEL_STYLE[entry.level];
  const colors = Colors[colorScheme];
  const { values, preview } = debugLogPreview(entry);
  const iconColor = entry.level === 'error' ? colors.danger : colors.warning;
  return (
    <View className={`flex-row gap-[6px] border-b border-b-border-light px-[8px] py-[2px] ${style.row}`}>
      <View className="h-[16px] w-[12px] items-center justify-center">
        {style.icon && <Ionicons name={style.icon} size={11} color={iconColor} />}
      </View>
      <View className="min-w-0 flex-1">
        <View className="flex-row gap-[12px]">
          {/* nw-keep(platform-css): system monospace stack for log text; the theme has no mono face */}
          <Text selectable style={LOG_MONO} className={`min-w-0 flex-1 text-[11px] leading-[16px] ${style.text}`}>
            <Text className="text-text-muted">{formatDebugLogTime(entry.timestamp)}  </Text>
            {entry.message}
          </Text>
          {/* nw-keep(platform-css): system monospace stack for the source column */}
          <Text numberOfLines={1} style={LOG_MONO} className="max-w-[30%] text-[11px] leading-[16px] text-text-muted">
            {entry.tag}
          </Text>
        </View>
        {values.length > 0 && (
          <Pressable
            onPress={() => onToggle(entry)}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            aria-expanded={expanded}
            className="flex-row items-start gap-[4px]"
          >
            <View className="h-[16px] w-[10px] items-center justify-center">
              <Ionicons name={expanded ? 'caret-down' : 'caret-forward'} size={9} color={colors.textMuted} />
            </View>
            {/* nw-keep(platform-css): monospace payload that may break inside long hex strings */}
            <Text selectable style={LOG_PAYLOAD} numberOfLines={expanded ? undefined : 2} className={`min-w-0 flex-1 text-[11px] leading-[16px] ${style.text}`}>
              <PayloadText tokens={expanded ? expandedPayloadTokens(values) : preview} colorScheme={colorScheme} />
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
});

const LOG_LEVEL_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
] as const;

function DebugOverlay({ collapsed, onToggleCollapsed }: { collapsed: boolean; onToggleCollapsed: () => void }) {
  const { colorScheme } = useTheme();
  const { getLogs, clearLogs, toggleOverlay, openExport } = useDebug();
  const { toast } = useToast();
  const [filter, setFilter] = useState<LogLevel | 'all'>('all');
  const [query, setQuery] = useState('');
  const [, setTick] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  // Follow new entries only while the reader is at the bottom; once they
  // scroll up to read something, new lines must not yank the view away.
  const followTail = useRef(true);
  const [expanded, setExpanded] = useState<ReadonlySet<LogEntry>>(() => new Set());
  // Clearing drops the entries, so drop their expanded state with them.
  const handleClear = () => {
    clearLogs();
    setExpanded(new Set());
  };
  const toggleExpanded = useCallback((entry: LogEntry) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(entry)) next.add(entry);
      return next;
    });
  }, []);
  const colors = Colors[colorScheme];

  // Refresh the display periodically
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const allLogs = getLogs();
  // No debounce: the per-entry payload serialisation is cached by entry
  // identity inside the filter, so a keystroke over the full 2000-entry buffer
  // is 2000 substring probes and the input can stay fully controlled.
  const filtered = useMemo(() => filterDebugLogs(allLogs, { level: filter, query }), [allLogs, filter, query]);
  const filterActive = isDebugLogFilterActive({ level: filter, query });

  // The full record: the export dialog chooses between everything since debug
  // mode was turned on and the last recording.
  const handleExport = () => openExport('session');

  /**
   * `copy` takes WHAT IS ON SCREEN, `save` takes the whole buffer.
   *
   * Copying is the "paste these lines into the bug report" action, so it has
   * to honour the search and the level chip that were used to find them; the
   * full record is one press away on `save`. The count in the toast is what
   * makes the two unambiguous at a glance.
   *
   * No success toast unless the clipboard write actually resolved: the write
   * is refusable (unfocused document, denied permission), and a false "copied"
   * sends someone off to paste a stale clipboard into that bug report. The old
   * feedback, a "Logs copied to clipboard" entry appended to the buffer, is
   * gone with the toast replacing it: it was easy to miss and it contaminated
   * the very buffer that had just been copied.
   */
  const handleCopy = async () => {
    if (filtered.length === 0) {
      toast({ title: 'No logs to copy', variant: 'warning' });
      return;
    }
    const content = formatDebugLogs(filtered);
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(content);
      } else {
        const Clipboard = await import('expo-clipboard');
        await Clipboard.setStringAsync(content);
      }
      toast({ title: describeCopiedLogs(filtered.length) });
    } catch {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  };

  const actionText = 'font-pp-sans-medium text-[12px] leading-[16px]';

  return (
    <View
      className={`absolute bottom-0 left-0 right-0 z-[999998] border-t border-t-border bg-menu-background ${collapsed ? '' : 'h-[45%]'}`}
      // nw-keep(platform-css): theme-dependent upward shadow that lifts the panel off the page
      style={debugPanelShadow(colorScheme)}
    >
      <View
        className={`flex-row items-center justify-between gap-[12px] px-[12px] py-[8px] ${collapsed ? '' : 'border-b border-b-border'}`}
      >
        <View className="min-w-0 shrink flex-row items-center gap-[8px]">
          <Text className="font-pp-sans-semi-bold text-[13px] leading-[18px] text-text">Debug logs</Text>
          <Text className="font-pp-sans text-[12px] leading-[16px] text-text-secondary">
            {formatDebugLogCount(filtered.length, allLogs.length, filterActive)}
          </Text>
          {/* Which world this session talks to; the switch is in the header menu. */}
          <Pill tone="neutral" label={appEnvironmentLabel(ACTIVE_APP_ENVIRONMENT)} testID="debug-environment-badge" />
        </View>
        {!collapsed && (
          <View className="flex-row gap-[4px]">
            {LOG_LEVEL_FILTERS.map(({ value, label }) => (
              <Pressable
                key={value}
                onPress={() => setFilter(value)}
                accessibilityRole="button"
                accessibilityState={{ selected: filter === value }}
                className={`rounded-pill px-[8px] py-[2px] ${filter === value ? 'bg-button-primary' : ''}`}
              >
                <Text className={`${actionText} ${filter === value ? 'text-button-primary-text' : 'text-text-secondary'}`}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        <View className="flex-row items-center gap-[4px]">
          {!collapsed && (
            <>
              <Pressable onPress={handleCopy} accessibilityRole="button" className="px-[8px] py-[2px]">
                <Text className={`${actionText} text-text-secondary`}>Copy</Text>
              </Pressable>
              <Pressable onPress={handleExport} accessibilityRole="button" className="px-[8px] py-[2px]">
                <Text className={`${actionText} text-text-secondary`}>Save</Text>
              </Pressable>
              <Pressable onPress={handleClear} accessibilityRole="button" className="px-[8px] py-[2px]">
                <Text className={`${actionText} text-danger`}>Clear</Text>
              </Pressable>
            </>
          )}
          <Pressable
            onPress={onToggleCollapsed}
            accessibilityRole="button"
            accessibilityLabel={collapsed ? 'Expand debug logs' : 'Collapse debug logs'}
            accessibilityState={{ expanded: !collapsed }}
            hitSlop={8}
            className="rounded-control p-[4px]"
            testID="debug-collapse-toggle"
          >
            <Ionicons name={collapsed ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textSecondary} />
          </Pressable>
          <Pressable
            onPress={toggleOverlay}
            accessibilityRole="button"
            accessibilityLabel="Close debug logs"
            hitSlop={8}
            className="rounded-control p-[4px]"
          >
            <Ionicons name="close" size={16} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>
      {!collapsed && (
        <>
          <View className="flex-row items-center gap-[6px] border-b border-b-border px-[12px] py-[6px]">
            <TextInput
              // Skipped by the clickstream recorder via this id (see onChange).
              nativeID={DEBUG_SEARCH_INPUT_ID}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              accessibilityLabel="Search logs"
              placeholder="Search"
              // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
              placeholderTextColor={colors.textMuted}
              // Tokens only: the panel sits on rgba white in light and rgba black
              // in dark, so a fixed hex field would read as disabled in one of
              // them. background-secondary + border lift the field off both.
              className="flex-1 rounded-control border border-border bg-background-secondary px-[8px] py-[4px] font-pp-sans text-[12px] text-text"
            />
            {query !== '' && (
              <Pressable
                onPress={() => setQuery('')}
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                hitSlop={8}
                className="rounded-control p-[4px]"
              >
                <Ionicons name="close" size={14} color={colors.textSecondary} />
              </Pressable>
            )}
          </View>
          <ScrollView
            ref={scrollRef}
            className="flex-1"
            scrollEventThrottle={100}
            onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
              followTail.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
            }}
            onContentSizeChange={() => {
              if (followTail.current) scrollRef.current?.scrollToEnd({ animated: false });
            }}
          >
            {filtered.map((entry, i) => (
              <DebugLogRow key={i} entry={entry} expanded={expanded.has(entry)} onToggle={toggleExpanded} colorScheme={colorScheme} />
            ))}
            {filtered.length === 0 && (
              <Text className="px-[12px] font-pp-sans text-[12px] leading-[18px] text-text-muted">
                {filterActive
                  ? 'No matches.'
                  : 'No logs. Interact with the app to generate entries.'}
              </Text>
            )}
          </ScrollView>
        </>
      )}
    </View>
  );
}

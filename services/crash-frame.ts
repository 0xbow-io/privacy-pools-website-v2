// What a render crash can say about WHERE it happened, as identifiers only.
//
// A production component stack on the web is Chrome's, and its first line is
// often an anonymous function with no name, `at https://host/file.js:12:34`.
// The old reader took the first identifier of the first line, which was `https`,
// so the V2-APP-5 events of 2026-10-30 said the crash came from a component
// called "https". These readers skip a line that names nothing and keep the
// position, which with the source maps Sentry holds is enough to find the line.
//
// Nothing here can carry a value: a name must be a bare identifier, and a
// position is the build's own file name plus two line numbers, written as one
// identifier. See ALLOWED_CODE_KEYS in services/error-reports-event.ts.

export interface CrashFrame {
  name?: string;
  file?: string;
  line?: number;
  col?: number;
}

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';
const NAMED_AT = new RegExp(`^\\s*at\\s+(${IDENT})\\s+\\((.*)\\)\\s*$`);
const ANON_AT = /^\s*at\s+(\S+)\s*$/;
const IN_NAME = new RegExp(`^\\s*in\\s+(${IDENT})(?:\\s|$)`);
// Firefox and Safari write an anonymous frame as `@https://host/file.js:1:2`.
const ANON_AT_SIGN = /^\s*@(\S+)\s*$/;
const AT_SIGN = new RegExp(`^\\s*(${IDENT})@(.*)$`);
const BARE_NAME = new RegExp(`^\\s*(${IDENT})\\s*$`);
// The build's file (index-4dcac2d4.js), never a path or a query: only the final
// segment, only characters a file name of ours has.
const LOCATION = /(?:^|[\s(/])([A-Za-z0-9_.-]+\.js):(\d+):(\d+)\)?$/;

function withLocation(frame: CrashFrame, where: string | undefined): CrashFrame {
  const match = where ? LOCATION.exec(where.trim()) : null;
  return match ? { ...frame, file: match[1], line: Number(match[2]), col: Number(match[3]) } : frame;
}

/** Every line of a component stack, as far as it can be read. */
export function parseComponentFrames(stack: string | null | undefined): CrashFrame[] {
  if (!stack) return [];
  const frames: CrashFrame[] = [];
  for (const line of stack.split('\n')) {
    let match: RegExpExecArray | null;
    if ((match = NAMED_AT.exec(line))) frames.push(withLocation({ name: match[1] }, match[2]));
    else if ((match = IN_NAME.exec(line))) frames.push({ name: match[1] });
    else if ((match = AT_SIGN.exec(line))) frames.push(withLocation({ name: match[1] }, match[2]));
    else if ((match = ANON_AT.exec(line))) frames.push(withLocation({}, match[1]));
    else if ((match = ANON_AT_SIGN.exec(line))) frames.push(withLocation({}, match[1]));
    else if ((match = BARE_NAME.exec(line))) frames.push({ name: match[1] });
  }
  return frames;
}

/** The first component that has a name. An anonymous frame above it is skipped, never read as `https`. */
export function firstComponentName(stack: string | null | undefined): string | undefined {
  return parseComponentFrames(stack).find((frame) => frame.name)?.name;
}

/** The code-identifier length limit in services/error-reports-event.ts (CODE_VALUE_MAX). */
export const POSITION_MAX = 64;

/**
 * Where the crash happened in the build, as ONE identifier of at most POSITION_MAX
 * characters: `at_index_ab12_js_1234_56` for index-ab12.js line 1234 column 56. The
 * first frame that has a position.
 *
 * The limit holds by construction, not by luck: an over-long value is dropped whole
 * by the constructor, and a real build file carries a 32-character content hash. So
 * the line and column are kept whole and the FILE part is cut to what is left (its
 * leading characters, which still name the bundle and begin the hash).
 */
export function firstFramePosition(stack: string | null | undefined): string | undefined {
  const frame = parseComponentFrames(stack).find((f) => f.file && f.line !== undefined && f.col !== undefined);
  if (!frame?.file) return undefined;
  const tail = `_${frame.line}_${frame.col}`;
  const room = POSITION_MAX - 'at_'.length - tail.length;
  if (room < 4) return undefined;
  const file = frame.file.replace(/[.-]/g, '_').slice(0, room);
  return `at_${file}${tail}`;
}

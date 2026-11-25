// @effect-diagnostics nodeBuiltinImport:off
// The failures that outlive trace rotation: a small file per UTC day, beside the trace files.
// Entries append synchronously so that the last one before a crash is on disk.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as Cause from "effect/Cause";
import type * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";
import type * as Tracer from "effect/Tracer";

import { errorTag } from "./observability.ts";

/** Today's file and the seven before it, so a failure stays readable for at least a week. */
export const ERROR_LOG_RETAINED_DAYS = 8;
/** Per process, which owns its files alone. A full day ends that day's entries and never evicts an earlier day's. */
export const ERROR_LOG_MAX_BYTES_PER_DAY = 2 * 1024 * 1024;
/** Names, ten frames and the allowlisted ids fit in about 2 KiB. */
export const ERROR_LOG_MAX_BYTES_PER_ENTRY = 4 * 1024;
/** Per day for one kind, name and error, so a retry storm leaves room for other failures. */
export const ERROR_LOG_MAX_ENTRIES_PER_KEY = 50;
/** After a failed write nothing is attempted for this long. */
export const ERROR_LOG_RETRY_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FRAMES = 10;
// Kept free for the line that names the daily limit.
const LIMIT_LINE_RESERVE_BYTES = 512;

// Span names are code-defined: `a.b`, `ssh/tunnel.start`, `http.client GET`.
const SPAN_NAME = /^(?=.{1,128}$)[A-Za-z][\w.:#$-]*(?:\/[\w.:#$-]+)?(?: [A-Z]+)?$/;
const UNNAMED = "[unnamed]";
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9.]{0,63}$/;
const TRACE_ID = /^[0-9a-f]{1,32}$/;
// Ids, which nest by percent-encoding, and enums. A path, a URL or a sentence holds a separator or
// a space. What an id may carry is the process's own rule.
const ATTRIBUTE_VALUE = /^[A-Za-z0-9][\w.:%-]{0,511}$/;
const ATTRIBUTE_KEY = /^[a-z][\w.]{0,127}$/;
// The frames end a stack; what precedes them is message text of any length.
const STACK_MAX_CHARS = 64 * 1024;
const FRAME_LINE = /^\s+at /;
// Function, file, line and column. The lazy function part leaves `Program Files (x86)` to the file.
const FRAME = /^\s+at (?:async )?(?:new )?(?:(.*?) \()?(.+):(\d{1,7}):(\d{1,7})\)?$/;
// Matching costs the square of a line's length; no frame of a real program is near this.
const FRAME_LINE_MAX_CHARS = 1024;
const EXECUTABLE_NAME = "houston";
const NODE_INTERNAL = "node:internal/";
const INDIRECT_PATH = /[?#]|(?:^|\/)\.\.(?:\/|$)/;
const DRIVE = /^\/?([A-Za-z]):\//;
const FILE_NAME = /^[\w.@-]{1,80}$/;
const FUNCTION_NAME = /^[A-Za-z_$][\w$.<>]{0,79}$/;
const SCRIPT_NAME = /\.[cm]?[jt]sx?$/;

// A logged error is an argument, or a field an object or two below one.
const SEARCH_MAX_READS = 256;
const SEARCH_MAX_DEPTH = 4;
const SEARCH_MAX_FIELDS = 64;

export interface ErrorLogFiles {
  readonly prepare: (directory: string) => void;
  readonly append: (filePath: string, text: string) => void;
  readonly list: (directory: string) => ReadonlyArray<string>;
  /** The file's size, and whether its last line was cut short. A missing file is empty. */
  readonly measure: (filePath: string) => { readonly bytes: number; readonly torn: boolean };
  readonly remove: (filePath: string) => void;
}

const NEWLINE = 0x0a;

const lastByteOf = (filePath: string, bytes: number) => {
  const file = NodeFS.openSync(filePath, "r");
  try {
    const last = Buffer.alloc(1);
    NodeFS.readSync(file, last, 0, 1, bytes - 1);
    return last[0];
  } finally {
    NodeFS.closeSync(file);
  }
};

const nodeFiles: ErrorLogFiles = {
  prepare: (directory) => NodeFS.mkdirSync(directory, { recursive: true }),
  append: (filePath, text) => NodeFS.appendFileSync(filePath, text, { mode: 0o600 }),
  list: (directory) => NodeFS.readdirSync(directory),
  measure: (filePath) => {
    const bytes = NodeFS.statSync(filePath, { throwIfNoEntry: false })?.size ?? 0;
    return { bytes, torn: bytes > 0 && lastByteOf(filePath, bytes) !== NEWLINE };
  },
  remove: (filePath) => NodeFS.rmSync(filePath, { force: true }),
};

/** Where the running program's code is. */
export interface ErrorLogProgram {
  /** Scripts below it are the program's own; undefined when the program is one executable. */
  readonly root: string | undefined;
  /** The file this module runs from, as the runtime names it in a stack. */
  readonly file: string;
}

export interface ErrorLogAttributes {
  readonly kept: Readonly<Record<string, unknown>>;
  /** How many ids were left out because they carry more than generated parts. */
  readonly omittedIds?: number;
}

export interface ErrorLogOptions {
  readonly directory: string;
  /** Each process writes its own files. */
  readonly process: "server" | "desktop";
  readonly clock: Clock.Clock;
  /** The allowlist: the recorded attributes this process may write. */
  readonly attributes: (recorded: Readonly<Record<string, unknown>>) => ErrorLogAttributes;
  readonly files?: ErrorLogFiles;
  readonly program?: ErrorLogProgram;
}

export interface ErrorLog {
  /** A span that ended with a failure. */
  readonly recordSpan: (span: Tracer.Span, cause: Cause.Cause<unknown>) => void;
  /** A log record; levels below Error are ignored. */
  readonly recordLog: (options: Logger.Options<unknown>) => void;
}

export const noopErrorLog: ErrorLog = { recordSpan: () => {}, recordLog: () => {} };

type Entry = Readonly<Record<string, unknown>>;

const dayOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis)).slice(0, 10);

// Not `.ndjson.<n>`: the "rotated logs" storage setting matches that suffix, and its one-day
// minimum must not shorten the week this log promises.
export const errorLogFileName = (process: ErrorLogOptions["process"], day: string) =>
  `${process}.errors-${day}.ndjson`;

const safely = <A>(read: () => A, fallback: A): A => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

const UNREADABLE: Entry = { error: "UnknownError" };

/** A stack's file URL or path in one form: forward slashes, decoded, a lower-case drive. */
const normalPath = (file: string) => {
  const path = file.startsWith("file://") ? decodeURIComponent(file.slice(7)) : file;
  return path
    .replaceAll("\\", "/")
    .replace(DRIVE, (_match, drive: string) => `${drive.toLowerCase()}:/`);
};

const directoryOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

/**
 * The program as this module's own stack names it: a bundle's directory, the repository when run
 * from source, or a single executable. It decides which frames are kept and is never written.
 */
const runningProgram = (): ErrorLogProgram => {
  for (const line of (new Error().stack ?? "").split("\n")) {
    const file = FRAME.exec(line)?.[2];
    if (file === undefined) continue;
    const path = normalPath(file);
    const directory = directoryOf(path);
    if (!SCRIPT_NAME.test(path)) return { root: undefined, file: path };
    const root = path.endsWith(".ts")
      ? directoryOf(directoryOf(directoryOf(directory)))
      : directory;
    // A root at the top of the file system would own every script.
    return { root: root === "" ? undefined : root, file: path };
  }
  return { root: undefined, file: "" };
};

const defaultProgram = runningProgram();

type OwnLocation = (file: string) => string | undefined;

/** A frame's printable file when it is the program's own or a Node built-in. */
const ownLocation = (program: ErrorLogProgram): OwnLocation => {
  const self = normalPath(program.file);
  const below = program.root === undefined ? undefined : `${normalPath(program.root)}/`;
  return (file) => {
    if (file.startsWith("node:")) return NodeModule.isBuiltin(file) ? file : undefined;
    const path = normalPath(file);
    const name = path.slice(path.lastIndexOf("/") + 1);
    // An executable's own name is whatever the user saved it as.
    if (below === undefined) return self !== "" && path === self ? EXECUTABLE_NAME : undefined;
    if (INDIRECT_PATH.test(path) || !FILE_NAME.test(name)) return undefined;
    return below !== undefined && path.startsWith(below) && SCRIPT_NAME.test(name)
      ? name
      : undefined;
  };
};

const framesOf = (error: unknown, own: OwnLocation): Entry => {
  if (!(error instanceof Error)) return {};
  const { stack, message } = error;
  if (typeof stack !== "string") return {};
  // A message that quotes a stack cannot be told from the error's own frames.
  if (
    typeof message === "string" &&
    message
      .slice(-STACK_MAX_CHARS)
      .split("\n")
      .some((line) => FRAME_LINE.test(line))
  ) {
    return {};
  }
  const frames: Array<string> = [];
  let dropped = 0;
  for (const line of stack.slice(-STACK_MAX_CHARS).split("\n")) {
    if (!FRAME_LINE.test(line)) continue;
    const match = line.length > FRAME_LINE_MAX_CHARS ? null : FRAME.exec(line);
    const [, fn, file = "", row, column] = match ?? [];
    const internal = file.startsWith(NODE_INTERNAL);
    const name = internal ? "node:internal" : safely(() => own(file), undefined);
    if (name === undefined) {
      dropped += 1;
      continue;
    }
    if (frames.length === MAX_FRAMES) continue;
    const location = internal ? name : `${name}:${row}:${column}`;
    frames.push(fn !== undefined && FUNCTION_NAME.test(fn) ? `${fn} (${location})` : location);
  }
  return {
    ...(frames.length === 0 ? {} : { frames }),
    ...(dropped === 0 ? {} : { droppedFrames: dropped }),
  };
};

/** The error's name and code locations; never its message, fields or nested causes. */
const describeError = (error: unknown, own: OwnLocation): Entry => {
  const tag = errorTag(error);
  return { error: ERROR_NAME.test(tag) ? tag : "Error", ...framesOf(error, own) };
};

const describeCause = (cause: Cause.Cause<unknown>, own: OwnLocation): Entry => {
  for (const reason of cause.reasons) {
    if (reason._tag === "Fail") return describeError(reason.error, own);
    if (reason._tag === "Die") return describeError(reason.defect, own);
  }
  return {};
};

/** The type of a value the search below does not look into. */
const typeNameOf = (value: object): Entry => {
  const prototype: unknown = Object.getPrototypeOf(value);
  const constructor: unknown = Predicate.isObject(prototype)
    ? Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
    : undefined;
  return typeof constructor === "function" && ERROR_NAME.test(constructor.name)
    ? { value: constructor.name }
    : {};
};

const isPlain = (value: object) => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null || Array.isArray(value);
};

interface Search {
  readonly own: OwnLocation;
  readonly seen: Set<object>;
  remainingReads: number;
}

const startSearch = (own: OwnLocation): Search => ({
  own,
  seen: new Set(),
  remainingReads: SEARCH_MAX_READS,
});

/** The first own values, read without getters; a large array's keys are never listed. */
function* firstFields(value: object, search: Search): Generator<unknown> {
  if (Array.isArray(value)) {
    const length = Math.min(value.length, SEARCH_MAX_FIELDS);
    for (let index = 0; index < length && search.remainingReads > 0; index += 1) {
      search.remainingReads -= 1;
      yield Object.getOwnPropertyDescriptor(value, index)?.value;
    }
    return;
  }
  let fields = SEARCH_MAX_FIELDS;
  for (const key in value) {
    if (fields === 0 || search.remainingReads <= 0) return;
    fields -= 1;
    search.remainingReads -= 1;
    yield Object.getOwnPropertyDescriptor(value, key)?.value;
  }
}

const describeLoggedValue = (value: unknown, search: Search, depth: number): Entry => {
  if (Cause.isCause(value)) return describeCause(value, search.own);
  if (value instanceof Error) return describeError(value, search.own);
  if (typeof value !== "object" || value === null) return {};
  if (!isPlain(value)) return typeNameOf(value);
  if (depth === SEARCH_MAX_DEPTH || search.seen.has(value)) return {};
  search.seen.add(value);
  let described: Entry = {};
  for (const field of firstFields(value, search)) {
    const found = safely(() => describeLoggedValue(field, search, depth + 1), UNREADABLE);
    if ("error" in found) return found;
    if ("value" in found) described = found;
  }
  return described;
};

/**
 * A log call's error. Message text is never written: it is often a template around a path, a title
 * or agent output, and nothing marks which part is constant. Only an error among it is described.
 */
const describeLogged = (options: Logger.Options<unknown>, own: OwnLocation): Entry => {
  if (options.cause.reasons.length > 0) return describeCause(options.cause, own);
  const search = startSearch(own);
  const message = describeLoggedValue(
    Array.isArray(options.message) ? options.message : [options.message],
    search,
    0,
  );
  if ("error" in message) return message;
  const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
  return { ...message, ...describeLoggedValue(annotations, search, 0) };
};

const writableAttributes = ({ kept, omittedIds = 0 }: ErrorLogAttributes): Entry => {
  const written: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(kept)) {
    if (!ATTRIBUTE_KEY.test(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") written[key] = value;
    else if (typeof value === "bigint") written[key] = String(value);
    else if (typeof value === "string" && ATTRIBUTE_VALUE.test(value)) written[key] = value;
  }
  return {
    ...(Object.keys(written).length === 0 ? {} : { attributes: written }),
    ...(omittedIds === 0 ? {} : { omittedIds }),
  };
};

const describeSpan = (span: Tracer.AnySpan): Entry => ({
  ...(span._tag === "Span" ? { name: SPAN_NAME.test(span.name) ? span.name : UNNAMED } : {}),
  ...(TRACE_ID.test(span.traceId) ? { traceId: span.traceId } : {}),
  ...(TRACE_ID.test(span.spanId) ? { spanId: span.spanId } : {}),
});

export const makeErrorLog = (options: ErrorLogOptions): ErrorLog => {
  const files = options.files ?? nodeFiles;
  const own = ownLocation(options.program ?? defaultProgram);
  const pathOf = (name: string) => NodePath.join(options.directory, name);
  const ownFile = new RegExp(`^${options.process}\\.errors-(\\d{4}-\\d{2}-\\d{2})\\.ndjson$`);

  let day = "";
  let filePath = "";
  // Unknown until the day's file is measured, and again after a failed write.
  let bytes: number | undefined;
  let torn = false;
  let full = false;
  let pausedUntil = 0;
  let countByKey = new Map<string, number>();

  const prune = (now: number) => {
    const oldest = dayOf(now - (ERROR_LOG_RETAINED_DAYS - 1) * DAY_MS);
    for (const name of safely(() => files.list(options.directory), [])) {
      const fileDay = ownFile.exec(name)?.[1];
      if (fileDay === undefined || fileDay >= oldest) continue;
      // Windows refuses while another program holds the file open; the next prune tries again.
      safely(() => files.remove(pathOf(name)), undefined);
    }
  };

  const openDay = (now: number) => {
    prune(now);
    day = dayOf(now);
    filePath = pathOf(errorLogFileName(options.process, day));
    bytes = undefined;
    full = false;
    countByKey = new Map();
  };

  const append = (entry: Entry) => {
    let text = `${JSON.stringify(entry)}\n`;
    const entryBytes = Buffer.byteLength(text);
    if (entryBytes > ERROR_LOG_MAX_BYTES_PER_ENTRY) {
      const { attributes: _attributes, frames: _frames, ...names } = entry;
      text = `${JSON.stringify({
        ...names,
        limit: "ERROR_LOG_MAX_BYTES_PER_ENTRY",
        maximum: ERROR_LOG_MAX_BYTES_PER_ENTRY,
        actual: entryBytes,
      })}\n`;
    }
    if (bytes === undefined) {
      files.prepare(options.directory);
      ({ bytes, torn } = files.measure(filePath));
    }
    if (torn) text = `\n${text}`;
    const next = bytes + Buffer.byteLength(text);
    if (next + LIMIT_LINE_RESERVE_BYTES <= ERROR_LOG_MAX_BYTES_PER_DAY) {
      files.append(filePath, text);
      bytes = next;
      torn = false;
      return;
    }
    full = true;
    const line = `${torn ? "\n" : ""}${JSON.stringify({
      time: entry.time,
      kind: "limit",
      limit: "ERROR_LOG_MAX_BYTES_PER_DAY",
      maximum: ERROR_LOG_MAX_BYTES_PER_DAY,
      reserved: LIMIT_LINE_RESERVE_BYTES,
      actual: next,
    })}\n`;
    if (bytes + Buffer.byteLength(line) <= ERROR_LOG_MAX_BYTES_PER_DAY)
      files.append(filePath, line);
  };

  // Runs inside whatever just failed, so nothing here may throw into it. Only a file that cannot
  // be written pauses the log; a value that cannot be read is described as such.
  const guarded = (now: number, body: () => void) => {
    if (now < pausedUntil) return;
    try {
      body();
    } catch {
      bytes = undefined;
      pausedUntil = now + ERROR_LOG_RETRY_MS;
    }
  };

  const record = (kind: "span" | "log", describe: () => Entry) => {
    const now = options.clock.currentTimeMillisUnsafe();
    guarded(now, () => {
      if (dayOf(now) !== day) openDay(now);
      if (full) return;
      const described = safely(describe, UNREADABLE);
      const { name, error } = described;
      const key = `${kind} ${String(name)} ${String(error)}`;
      const count = (countByKey.get(key) ?? 0) + 1;
      const time = DateTime.formatIso(DateTime.makeUnsafe(now));
      if (count <= ERROR_LOG_MAX_ENTRIES_PER_KEY) append({ time, kind, ...described });
      else if (count === ERROR_LOG_MAX_ENTRIES_PER_KEY + 1) {
        append({
          time,
          kind: "limit",
          limit: "ERROR_LOG_MAX_ENTRIES_PER_KEY",
          maximum: ERROR_LOG_MAX_ENTRIES_PER_KEY,
          actual: count,
          ...(name === undefined ? {} : { name }),
          ...(error === undefined ? {} : { error }),
        });
      }
      countByKey.set(key, count);
    });
  };

  const startedAt = options.clock.currentTimeMillisUnsafe();
  guarded(startedAt, () => openDay(startedAt));

  return {
    recordSpan: (span, cause) =>
      record("span", () => ({
        ...describeSpan(span),
        ...(Option.isSome(span.parent) && TRACE_ID.test(span.parent.value.spanId)
          ? { parentSpanId: span.parent.value.spanId }
          : {}),
        ...(span.status._tag === "Ended"
          ? { durationMs: Number(span.status.endTime - span.status.startTime) / 1_000_000 }
          : {}),
        ...safely(() => describeCause(cause, own), UNREADABLE),
        ...safely(
          () => writableAttributes(options.attributes(Object.fromEntries(span.attributes))),
          {},
        ),
      })),
    recordLog: (logged) => {
      if (logged.logLevel !== "Error" && logged.logLevel !== "Fatal") return;
      record("log", () => ({
        level: logged.logLevel,
        ...(logged.fiber.cache.span === undefined ? {} : describeSpan(logged.fiber.cache.span)),
        ...safely(() => describeLogged(logged, own), UNREADABLE),
        ...safely(
          () =>
            writableAttributes(
              options.attributes(logged.fiber.getRef(References.CurrentLogAnnotations)),
            ),
          {},
        ),
      }));
    },
  };
};

export const errorLogger = (errorLog: ErrorLog): Logger.Logger<unknown, void> =>
  Logger.make((options) => errorLog.recordLog(options));

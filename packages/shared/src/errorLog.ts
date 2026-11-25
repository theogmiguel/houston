// @effect-diagnostics nodeBuiltinImport:off
// The failures that outlive trace rotation: a small file per UTC day, beside the trace files.
// Entries append synchronously so that the last one before a crash is on disk.
import * as NodeFS from "node:fs";
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
/** Per process. A full day ends that day's entries and never evicts an earlier day's. */
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
// Ids and enums. A path, a URL or a sentence holds a separator or a space.
const ATTRIBUTE_VALUE = /^[A-Za-z0-9][\w.:-]{0,127}$/;
// Longer lines are message text, which the pattern below must not scan.
const FRAME_LINE_MAX_CHARS = 1024;
const FRAME_LINE = /^\s+at /;
const FRAME =
  /^\s+at (?:async )?(?:new )?(?:(.*) \()?(node:)?(?:.*[\\/])?([\w.@-]{1,80}):(\d+):(\d+)\)?$/;
const FUNCTION_NAME = /^[A-Za-z_$][\w$.<>]{0,79}$/;
const SCRIPT_NAME = /\.[cm]?[jt]sx?$/;

export interface ErrorLogFiles {
  readonly prepare: (directory: string) => void;
  readonly append: (filePath: string, text: string) => void;
  readonly list: (directory: string) => ReadonlyArray<string>;
  readonly size: (filePath: string) => number;
  readonly remove: (filePath: string) => void;
}

const nodeFiles: ErrorLogFiles = {
  prepare: (directory) => NodeFS.mkdirSync(directory, { recursive: true }),
  append: (filePath, text) => NodeFS.appendFileSync(filePath, text, { mode: 0o600 }),
  list: (directory) => NodeFS.readdirSync(directory),
  size: (filePath) => NodeFS.statSync(filePath, { throwIfNoEntry: false })?.size ?? 0,
  remove: (filePath) => NodeFS.rmSync(filePath, { force: true }),
};

export interface ErrorLogOptions {
  readonly directory: string;
  /** Each process writes its own files. */
  readonly process: "server" | "desktop";
  readonly clock: Clock.Clock;
  /** The allowlist: the recorded attributes this process may write. */
  readonly attributes: (recorded: Readonly<Record<string, unknown>>) => Record<string, unknown>;
  readonly files?: ErrorLogFiles;
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

const framesOf = (error: unknown): ReadonlyArray<string> => {
  if (!(error instanceof Error) || typeof error.stack !== "string") return [];
  const lines = error.stack.split("\n");
  // A message that quotes a stack cannot be told from the error's own frames.
  if (error.message.split("\n").some((line) => FRAME_LINE.test(line))) return [];
  const frames: Array<string> = [];
  for (const line of lines) {
    const match = line.length > FRAME_LINE_MAX_CHARS ? null : FRAME.exec(line);
    if (match === null) continue;
    const [, fn, node = "", file = "", row = "", column = ""] = match;
    if (node === "" && !SCRIPT_NAME.test(file)) continue;
    const location = `${node}${file}:${row}:${column}`;
    frames.push(fn !== undefined && FUNCTION_NAME.test(fn) ? `${fn} (${location})` : location);
    if (frames.length === MAX_FRAMES) break;
  }
  return frames;
};

/** The error's name and code locations; never its message, fields or nested causes. */
const describeError = (error: unknown): Entry => {
  const tag = errorTag(error);
  const frames = framesOf(error);
  return {
    error: ERROR_NAME.test(tag) ? tag : "Error",
    ...(frames.length === 0 ? {} : { frames }),
  };
};

const describeCause = (cause: Cause.Cause<unknown>): Entry => {
  for (const reason of cause.reasons) {
    if (reason._tag === "Fail") return describeError(reason.error);
    if (reason._tag === "Die") return describeError(reason.defect);
  }
  return {};
};

const describeValue = (value: unknown): Entry | undefined =>
  Cause.isCause(value)
    ? describeCause(value)
    : value instanceof Error
      ? describeError(value)
      : undefined;

/**
 * A log call's error. Message text is never written: it is often a template around a path, a title
 * or agent output, and nothing marks which part is constant. Only an error among it is described.
 */
const describeLogged = (options: Logger.Options<unknown>): Entry => {
  if (options.cause.reasons.length > 0) return describeCause(options.cause);
  const parts: ReadonlyArray<unknown> = Array.isArray(options.message)
    ? options.message
    : [options.message];
  for (const part of [...parts, options.fiber.getRef(References.CurrentLogAnnotations)]) {
    const described = describeValue(part);
    if (described !== undefined) return described;
    if (!Predicate.isObject(part)) continue;
    for (const { value } of Object.values(Object.getOwnPropertyDescriptors(part))) {
      const field = describeValue(value);
      if (field !== undefined) return field;
    }
  }
  return {};
};

const writableAttributes = (attributes: Readonly<Record<string, unknown>>): Entry => {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "number" || typeof value === "boolean") kept[key] = value;
    else if (typeof value === "bigint") kept[key] = String(value);
    else if (typeof value === "string" && ATTRIBUTE_VALUE.test(value)) kept[key] = value;
  }
  return Object.keys(kept).length === 0 ? {} : { attributes: kept };
};

const describeSpan = (span: Tracer.AnySpan): Entry => ({
  ...(span._tag === "Span" ? { name: SPAN_NAME.test(span.name) ? span.name : UNNAMED } : {}),
  ...(TRACE_ID.test(span.traceId) ? { traceId: span.traceId } : {}),
  ...(TRACE_ID.test(span.spanId) ? { spanId: span.spanId } : {}),
});

export const makeErrorLog = (options: ErrorLogOptions): ErrorLog => {
  const files = options.files ?? nodeFiles;
  const pathOf = (name: string) => NodePath.join(options.directory, name);
  const ownFile = new RegExp(`^${options.process}\\.errors-(\\d{4}-\\d{2}-\\d{2})\\.ndjson$`);

  let day = "";
  let filePath = "";
  // Unknown until the day's file is measured, and again after a failed write.
  let bytes: number | undefined;
  let full = false;
  let pausedUntil = 0;
  let countByKey = new Map<string, number>();

  const prune = (now: number) => {
    const oldest = dayOf(now - (ERROR_LOG_RETAINED_DAYS - 1) * DAY_MS);
    for (const name of files.list(options.directory)) {
      const fileDay = ownFile.exec(name)?.[1];
      if (fileDay === undefined || fileDay >= oldest) continue;
      try {
        files.remove(pathOf(name));
      } catch {
        // Windows refuses while another program holds the file open; the next prune tries again.
      }
    }
  };

  const openDay = (now: number) => {
    files.prepare(options.directory);
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
    const size = (bytes ??= files.size(filePath));
    const next = size + Buffer.byteLength(text);
    if (next + LIMIT_LINE_RESERVE_BYTES <= ERROR_LOG_MAX_BYTES_PER_DAY) {
      files.append(filePath, text);
      bytes = next;
      return;
    }
    full = true;
    const line = `${JSON.stringify({
      time: entry.time,
      kind: "limit",
      limit: "ERROR_LOG_MAX_BYTES_PER_DAY",
      maximum: ERROR_LOG_MAX_BYTES_PER_DAY,
      actual: next + LIMIT_LINE_RESERVE_BYTES,
    })}\n`;
    if (size + Buffer.byteLength(line) <= ERROR_LOG_MAX_BYTES_PER_DAY) files.append(filePath, line);
  };

  // Runs inside whatever just failed, so nothing here may throw into it.
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
      const described = describe();
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
        ...describeCause(cause),
        ...writableAttributes(options.attributes(Object.fromEntries(span.attributes))),
      })),
    recordLog: (logged) => {
      if (logged.logLevel !== "Error" && logged.logLevel !== "Fatal") return;
      record("log", () => ({
        level: logged.logLevel,
        ...(logged.fiber.cache.span === undefined ? {} : describeSpan(logged.fiber.cache.span)),
        ...describeLogged(logged),
        ...writableAttributes(
          options.attributes(logged.fiber.getRef(References.CurrentLogAnnotations)),
        ),
      }));
    },
  };
};

export const errorLogger = (errorLog: ErrorLog): Logger.Logger<unknown, void> =>
  Logger.make((options) => errorLog.recordLog(options));

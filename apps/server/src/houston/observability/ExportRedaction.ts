// What leaves the machine through OTLP export. The local trace file keeps full detail; an
// exported copy keeps only ids Houston generated, closed enums, numbers, booleans and
// code-defined constants, so no path, URL, message or user text reaches a receiver.
import type * as OtlpTracer from "effect/observability/OtlpTracer";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";

import { outcomeFromExit } from "../../observability/Attributes.ts";
import { applyCredentialRules, credentialRules, cutAbsolutePaths } from "../redact.ts";

const EXPORTED_PREFIXES = ["houston.", "rpc.", "orchestration_v2."];
const EXPORTED_KEYS: ReadonlySet<string> = new Set([
  "db.system.name",
  "db.namespace",
  "db.operation.name",
  "db.collection.name",
  "db.query.text",
  "http.request.method",
  "http.response.status_code",
  "http.route",
  "server.address",
  "server.port",
  "url.scheme",
  "error.type",
  "exception.type",
  "code.function",
  "effect.logLevel",
  "memory.heap_growth_bytes",
]);
// Statement templates carry placeholders; a long one is cut rather than dropped.
const QUERY_TEXT_MAX_CHARS = 2048;
// Log messages are reduced to their first string; this bounds one that interpolates a payload.
const LOG_MESSAGE_MAX_CHARS = 256;
const URL_ORIGIN = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i;
const URL_ANYWHERE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const CREDENTIALS = credentialRules("[redacted]");

/** Event name for a span event that a log call produced; its text is the log message. */
export const LOG_EVENT_NAME = "log";

export const isExportedKey = (key: string): boolean =>
  EXPORTED_KEYS.has(key) || EXPORTED_PREFIXES.some((prefix) => key.startsWith(prefix));

const isScalar = (value: unknown) =>
  Predicate.isString(value) ||
  Predicate.isNumber(value) ||
  Predicate.isBoolean(value) ||
  Predicate.isBigInt(value);

/** The exported attributes for one recorded key and value: none, the value, or a derived form. */
export const exportedAttributes = (
  key: string,
  value: unknown,
): ReadonlyArray<readonly [string, unknown]> => {
  if (key === "url.full") {
    if (!Predicate.isString(value)) return [];
    const origin = URL_ORIGIN.exec(value);
    return origin === null
      ? []
      : [
          ["url.scheme", origin[1]!.toLowerCase()],
          ["server.address", origin[2]!],
        ];
  }
  if (!isExportedKey(key)) return [];
  if (key === "db.query.text" && Predicate.isString(value)) {
    return [[key, value.slice(0, QUERY_TEXT_MAX_CHARS)]];
  }
  if (isScalar(value)) return [[key, value]];
  if (Array.isArray(value) && value.every(isScalar)) return [[key, value]];
  return [];
};

export const exportedRecord = (
  attributes: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> => {
  const exported: Record<string, unknown> = {};
  if (attributes === undefined) return exported;
  for (const [key, value] of Object.entries(attributes)) {
    for (const [exportedKey, exportedValue] of exportedAttributes(key, value)) {
      exported[exportedKey] = exportedValue;
    }
  }
  return exported;
};

const tagOf = (value: unknown): string | undefined => {
  if (Predicate.hasProperty(value, "_tag") && Predicate.isString(value._tag)) return value._tag;
  if (value instanceof Error) return value.name;
  return undefined;
};

/** `_tag` (or error name) of the first failure or defect; undefined for success or interrupts. */
export const errorTag = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  for (const reason of exit.cause.reasons) {
    if (reason._tag === "Fail") return tagOf(reason.error) ?? "UnknownError";
    if (reason._tag === "Die") return tagOf(reason.defect) ?? "UnknownDefect";
  }
  return undefined;
};

/** A cause reduced to its error tag: messages, stacks and payloads can hold paths and user text. */
export const exportedCause = (cause: Cause.Cause<unknown>): Cause.Cause<unknown> => {
  if (cause.reasons.length === 0 || Cause.hasInterruptsOnly(cause)) return cause;
  const tag = errorTag(Exit.failCause(cause)) ?? "UnknownError";
  return Cause.die({ name: tag, message: tag });
};

export const exportedExit = (exit: Exit.Exit<unknown, unknown>): Exit.Exit<unknown, unknown> =>
  Exit.isSuccess(exit) ? Exit.void : Exit.failCause(exportedCause(exit.cause));

/** Outcome attributes a span gains as it ends. */
export const endAttributes = (
  exit: Exit.Exit<unknown, unknown>,
): ReadonlyArray<readonly [string, string]> => {
  const tag = errorTag(exit);
  return tag === undefined
    ? [["houston.outcome", outcomeFromExit(exit)]]
    : [
        ["houston.outcome", outcomeFromExit(exit)],
        ["houston.error.tag", tag],
      ];
};

/** A log message as exported: its first string, without paths, URLs or credentials. */
export const exportedLogMessage = (message: unknown): string => {
  const first = Array.isArray(message) ? message.find(Predicate.isString) : message;
  if (!Predicate.isString(first)) return LOG_EVENT_NAME;
  const scrubbed = applyCredentialRules(cutAbsolutePaths(first), CREDENTIALS).replace(
    URL_ANYWHERE,
    "[url]",
  );
  return scrubbed.slice(0, LOG_MESSAGE_MAX_CHARS);
};

type OtlpSpan = OtlpTracer.ScopeSpan["spans"][number];
type KeyValue = OtlpSpan["attributes"][number];

const exportedKeyValues = (attributes: ReadonlyArray<KeyValue> | undefined): Array<KeyValue> => {
  const exported: Array<KeyValue> = [];
  for (const attribute of attributes ?? []) {
    if (attribute.key === "url.full") {
      const url = attribute.value?.stringValue;
      for (const [key, value] of exportedAttributes("url.full", url)) {
        exported.push({ key, value: { stringValue: String(value) } });
      }
      continue;
    }
    if (!isExportedKey(attribute.key)) continue;
    const text = attribute.value?.stringValue;
    exported.push(
      attribute.key === "db.query.text" && Predicate.isString(text)
        ? { key: attribute.key, value: { stringValue: text.slice(0, QUERY_TEXT_MAX_CHARS) } }
        : attribute,
    );
  }
  return exported;
};

const exportedSpan = (span: OtlpSpan): OtlpSpan => {
  const status: OtlpSpan["status"] = { code: span.status?.code };
  return {
    ...span,
    attributes: exportedKeyValues(span.attributes),
    events: (span.events ?? []).map((event) => ({
      ...event,
      name: event.name === "exception" ? event.name : LOG_EVENT_NAME,
      attributes: exportedKeyValues(event.attributes),
    })),
    links: (span.links ?? []).map((link) => ({
      ...link,
      attributes: exportedKeyValues(link.attributes),
    })),
    status,
  };
};

/** A browser OTLP/JSON trace batch as forwarded to the configured receiver. */
export const exportedTraceData = (data: OtlpTracer.TraceData): OtlpTracer.TraceData => ({
  resourceSpans: (data.resourceSpans ?? []).map((resourceSpan) => ({
    ...resourceSpan,
    scopeSpans: (resourceSpan.scopeSpans ?? []).map((scopeSpan) => ({
      ...scopeSpan,
      spans: (scopeSpan.spans ?? []).map(exportedSpan),
    })),
  })),
});

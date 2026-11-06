// What leaves the machine through OTLP export. The local trace file keeps full detail; an
// exported copy keeps only ids Houston generated, closed enums, numbers, booleans and
// code-defined constants, so no path, URL, message or user text reaches a receiver.
import type * as OtlpTracer from "effect/observability/OtlpTracer";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";

import { outcomeFromExit } from "../../observability/Attributes.ts";

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
const URL_ORIGIN = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i;

// The resource names the service, its version, channel and runtime; never the machine.
const RESOURCE_PREFIXES = ["service.", "telemetry.sdk.", "houston.", "process.runtime."];
const RESOURCE_KEYS: ReadonlySet<string> = new Set(["deployment.environment.name"]);
const LOG_LEVEL_KEY = "effect.logLevel";
const INTERRUPTED = "Interrupted";

// A log message is often a template filled with error text, paths or titles, and nothing marks
// which part is constant, so exported logs and log span events carry this instead.
export const LOG_EVENT_NAME = "log";

// Code-defined event names (`exception`, `git.hook.started`); a log call's event is named by its
// message, so any other name is exported as `log`.
const EVENT_NAME = /^(exception|[a-z][a-z0-9_]*(\.[a-z0-9_]+)+)$/;

export const exportedEventName = (name: string, attributeKeys: Iterable<string>): string => {
  for (const key of attributeKeys) if (key === LOG_LEVEL_KEY) return LOG_EVENT_NAME;
  return EVENT_NAME.test(name) ? name : LOG_EVENT_NAME;
};

export const isExportedResourceKey = (key: string): boolean =>
  RESOURCE_KEYS.has(key) || RESOURCE_PREFIXES.some((prefix) => key.startsWith(prefix));

export const exportedResourceAttributes = <V>(
  attributes: Readonly<Record<string, V>>,
): Record<string, V> =>
  Object.fromEntries(Object.entries(attributes).filter(([key]) => isExportedResourceKey(key)));

/** An OTLP exporter's resource option with only allowlisted attributes. */
export const exportedResource = <T extends { readonly attributes?: Record<string, unknown> }>(
  resource: T,
): T =>
  resource.attributes === undefined
    ? resource
    : { ...resource, attributes: exportedResourceAttributes(resource.attributes) };

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

// A cause reduced to its error tag, or "Interrupted": messages, stacks, payloads and interruptor
// stacks can hold paths and user text.
export const exportedCause = (cause: Cause.Cause<unknown>): Cause.Cause<unknown> => {
  if (cause.reasons.length === 0) return cause;
  const tag = Cause.hasInterruptsOnly(cause)
    ? INTERRUPTED
    : (errorTag(Exit.failCause(cause)) ?? "UnknownError");
  return Cause.die({ name: tag, message: tag });
};

// An interrupted span stays interrupted (exporters print no error for it), without its interruptor.
export const exportedExit = (exit: Exit.Exit<unknown, unknown>): Exit.Exit<unknown, unknown> =>
  Exit.isSuccess(exit)
    ? Exit.void
    : Cause.hasInterruptsOnly(exit.cause)
      ? Exit.interrupt()
      : Exit.failCause(exportedCause(exit.cause));

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
      name: exportedEventName(
        event.name,
        (event.attributes ?? []).map((attribute) => attribute.key),
      ),
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
    resource: {
      ...resourceSpan.resource,
      attributes: (resourceSpan.resource?.attributes ?? []).filter((attribute) =>
        isExportedResourceKey(attribute.key),
      ),
    },
    scopeSpans: (resourceSpan.scopeSpans ?? []).map((scopeSpan) => ({
      ...scopeSpan,
      spans: (scopeSpan.spans ?? []).map(exportedSpan),
    })),
  })),
});

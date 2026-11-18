import { describe, expect, it } from "@effect/vitest";
import type { EffectTraceRecord } from "@houston-app/shared/observability";

import { keepServerTraceRecord } from "./QuietSqlSpans.ts";

const span = (overrides: Partial<EffectTraceRecord>): EffectTraceRecord =>
  ({
    type: "effect-span",
    name: "sqlite",
    traceId: "trace",
    spanId: "span",
    sampled: true,
    kind: "internal",
    startTimeUnixNano: "0",
    endTimeUnixNano: "0",
    durationMs: 0.2,
    attributes: { "db.lock_wait_ms": 0.002 },
    events: [],
    links: [],
    exit: { _tag: "Success" },
    ...overrides,
  }) as EffectTraceRecord;

describe("keepServerTraceRecord", () => {
  it.each(["sqlite", "BEGIN", "COMMIT", "sql.transaction"])(
    "leaves a fast successful %s span out of the local trace",
    (name) => {
      expect(keepServerTraceRecord(span({ name }))).toBe(false);
    },
  );

  it("keeps a slow statement", () => {
    expect(keepServerTraceRecord(span({ durationMs: 25 }))).toBe(true);
  });

  it("keeps a statement that waited on the database lock", () => {
    expect(keepServerTraceRecord(span({ attributes: { "db.lock_wait_ms": 40 } }))).toBe(true);
  });

  it("keeps a failed statement however fast", () => {
    expect(keepServerTraceRecord(span({ exit: { _tag: "Failure", cause: "SQLITE_BUSY" } }))).toBe(
      true,
    );
  });

  it("keeps every span that is not a statement", () => {
    expect(keepServerTraceRecord(span({ name: "EventStoreV2.latestSequence" }))).toBe(true);
  });
});

import { assert, describe, it } from "@effect/vitest";

import {
  APP_DEBUG_MESSAGE_MAX_BYTES,
  APP_DEBUG_PAYLOAD_MAX_BYTES,
  APP_DEBUG_SCHEMA_VERSION,
  APP_DEBUG_SOURCE_MAX_BYTES,
  buildAppDebugRecord,
} from "./DesktopAppDebugLog.ts";

describe("buildAppDebugRecord", () => {
  it("rejects an empty source", () => {
    assert.throws(
      () => buildAppDebugRecord("", "hello", undefined),
      /source must be a non-empty string/,
    );
  });

  it("rejects a source over the byte cap and names the actual size", () => {
    const source = "x".repeat(APP_DEBUG_SOURCE_MAX_BYTES + 1);
    assert.throws(
      () => buildAppDebugRecord(source, "hello", undefined),
      new RegExp(`${APP_DEBUG_SOURCE_MAX_BYTES}.*${APP_DEBUG_SOURCE_MAX_BYTES + 1}`),
    );
  });

  it("accepts a source at exactly the cap", () => {
    const source = "x".repeat(APP_DEBUG_SOURCE_MAX_BYTES);
    const record = buildAppDebugRecord(source, "hello", undefined);
    assert.strictEqual(record.source, source);
  });

  it("truncates an oversized message and records the truncation", () => {
    const message = "m".repeat(APP_DEBUG_MESSAGE_MAX_BYTES + 10);
    const record = buildAppDebugRecord("terminal-transport", message, undefined);
    assert.strictEqual(record.message.length, APP_DEBUG_MESSAGE_MAX_BYTES);
    assert.deepStrictEqual(record.message_truncation, {
      limit_bytes: APP_DEBUG_MESSAGE_MAX_BYTES,
      actual_bytes: APP_DEBUG_MESSAGE_MAX_BYTES + 10,
    });
  });

  it("never splits a multi-byte character while truncating", () => {
    const message = "あ".repeat(APP_DEBUG_MESSAGE_MAX_BYTES);
    const record = buildAppDebugRecord("terminal-transport", message, undefined);
    const bytes = new TextEncoder().encode(record.message).length;
    assert.isBelow(bytes, APP_DEBUG_MESSAGE_MAX_BYTES);
    assert.isTrue(bytes % 3 === 0);
    assert.isNotNull(record.message_truncation);
  });

  it("keeps a message at exactly the cap untruncated", () => {
    const message = "m".repeat(APP_DEBUG_MESSAGE_MAX_BYTES);
    const record = buildAppDebugRecord("terminal-transport", message, undefined);
    assert.isNull(record.message_truncation);
  });

  it("drops an oversized payload and says so", () => {
    const payload = "p".repeat(APP_DEBUG_PAYLOAD_MAX_BYTES + 100);
    const record = buildAppDebugRecord("terminal-transport", "hello", payload);
    assert.isNull(record.payload);
    assert.deepStrictEqual(record.payload_truncation, {
      limit_bytes: APP_DEBUG_PAYLOAD_MAX_BYTES,
      actual_bytes: APP_DEBUG_PAYLOAD_MAX_BYTES + 102,
    });
  });

  it("keeps a payload within the cap", () => {
    const payload = { session: 3, class: "bulk" };
    const record = buildAppDebugRecord("terminal-transport", "hello", payload);
    assert.deepStrictEqual(record.payload, payload);
    assert.isNull(record.payload_truncation);
  });

  it("writes the documented key set", () => {
    const record = buildAppDebugRecord("watchers", "hello", { a: 1 });
    assert.deepStrictEqual(Object.keys(record).sort(), [
      "message",
      "message_truncation",
      "payload",
      "payload_truncation",
      "schema",
      "source",
      "ts_wall",
    ]);
    assert.strictEqual(record.schema, APP_DEBUG_SCHEMA_VERSION);
  });
});

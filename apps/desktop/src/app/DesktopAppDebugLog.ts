// @effect-diagnostics globalDate:off preferSchemaOverJson:off - Pure debug record builder; it runs outside an Effect runtime and serialises caller-supplied JSON.
export const APP_DEBUG_SCHEMA_VERSION = 1;

// Bounded so a caller cannot wedge an unbounded tag into the record position; the
// longest real tag is 18 bytes, so 64 leaves headroom while still catching an
// obviously wrong value passed where a tag was expected.
export const APP_DEBUG_SOURCE_MAX_BYTES = 64;

export const APP_DEBUG_MESSAGE_MAX_BYTES = 1024;

export const APP_DEBUG_PAYLOAD_MAX_BYTES = 4096;

export interface AppDebugTruncation {
  readonly limit_bytes: number;
  readonly actual_bytes: number;
}

export interface AppDebugRecord {
  readonly schema: number;
  readonly ts_wall: number;
  readonly source: string;
  readonly message: string;
  readonly payload: unknown;
  readonly message_truncation: AppDebugTruncation | null;
  readonly payload_truncation: AppDebugTruncation | null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) {
    return value;
  }
  const encoder = new TextEncoder();
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).length;
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    bytes += characterBytes;
    end += character.length;
  }
  return value.slice(0, end);
}

export function buildAppDebugRecord(
  source: string,
  message: string,
  payload: unknown,
): AppDebugRecord {
  const sourceBytes = byteLength(source);
  if (sourceBytes === 0 || sourceBytes > APP_DEBUG_SOURCE_MAX_BYTES) {
    throw new Error(
      `logDebug: source must be a non-empty string of at most ${APP_DEBUG_SOURCE_MAX_BYTES} bytes, got ${JSON.stringify(source)} (${sourceBytes} bytes)`,
    );
  }

  const messageBytes = byteLength(message);
  const messageTruncation =
    messageBytes > APP_DEBUG_MESSAGE_MAX_BYTES
      ? { limit_bytes: APP_DEBUG_MESSAGE_MAX_BYTES, actual_bytes: messageBytes }
      : null;
  const boundedMessage =
    messageTruncation === null ? message : truncateUtf8(message, APP_DEBUG_MESSAGE_MAX_BYTES);

  let boundedPayload: unknown = null;
  let payloadTruncation: AppDebugTruncation | null = null;
  if (payload !== undefined) {
    const serialized = JSON.stringify(payload);
    const serializedBytes = byteLength(serialized);
    if (serializedBytes > APP_DEBUG_PAYLOAD_MAX_BYTES) {
      payloadTruncation = {
        limit_bytes: APP_DEBUG_PAYLOAD_MAX_BYTES,
        actual_bytes: serializedBytes,
      };
    } else {
      boundedPayload = payload;
    }
  }

  return {
    schema: APP_DEBUG_SCHEMA_VERSION,
    ts_wall: Date.now(),
    source,
    message: boundedMessage,
    payload: boundedPayload,
    message_truncation: messageTruncation,
    payload_truncation: payloadTruncation,
  };
}

import { sha256 } from "@noble/hashes/sha2";
import * as Hex from "effect/encoding/Hex";

const IS_TELEMETRY_ID_HASH_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Hashes an identifier before it reaches analytics. Clients and the server both
 * use it, so one Connect account gives the same owner id on every surface.
 */
export const hashTelemetryId = (value: string): string =>
  Hex.encode(sha256(new TextEncoder().encode(value)));

/** True for a `hashTelemetryId` result. The server accepts only this shape from clients. */
export const isTelemetryIdHash = (value: string): boolean =>
  IS_TELEMETRY_ID_HASH_PATTERN.test(value);

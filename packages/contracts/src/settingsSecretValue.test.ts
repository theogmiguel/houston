import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { EasDeviceHostConfig, SimlockDeviceHostConfig } from "./device.ts";
import { SETTINGS_SECRET_MAX_BYTES, SettingsSecretValue } from "./settingsSecretValue.ts";

const decodeSecret = Schema.decodeUnknownSync(SettingsSecretValue);
const decodeEas = Schema.decodeUnknownSync(EasDeviceHostConfig);
const decodeSimlock = Schema.decodeUnknownSync(SimlockDeviceHostConfig);

const atLimit = "a".repeat(SETTINGS_SECRET_MAX_BYTES);
const overLimit = "a".repeat(SETTINGS_SECRET_MAX_BYTES + 1);

describe("credential size bound", () => {
  it("accepts a literal at the limit and refuses one above it, naming the limit and size", () => {
    expect(decodeSecret(atLimit)).toBe(atLimit);
    expect(() => decodeSecret(overLimit)).toThrow(
      `${SETTINGS_SECRET_MAX_BYTES + 1} bytes, over the limit of ${SETTINGS_SECRET_MAX_BYTES} bytes`,
    );
  });

  it("counts bytes, not characters", () => {
    // Each "é" is two UTF-8 bytes, so half the limit in characters already fills it.
    const multibyte = "é".repeat(SETTINGS_SECRET_MAX_BYTES / 2 + 1);
    expect(() => decodeSecret(multibyte)).toThrow(`${SETTINGS_SECRET_MAX_BYTES + 2} bytes`);
  });

  it("measures the trimmed value", () => {
    expect(decodeSecret(`  ${atLimit}  `)).toBe(atLimit);
  });

  it("still accepts a secret reference", () => {
    expect(decodeSecret({ provider: "vault", reference: "ops/token" })).toEqual({
      provider: "vault",
      reference: "ops/token",
    });
  });

  it("bounds the EAS access token and names the field", () => {
    const base = { kind: "eas", id: "eas", label: "EAS" };
    expect(decodeEas({ ...base, accessToken: atLimit }).accessToken).toBe(atLimit);
    expect(() => decodeEas({ ...base, accessToken: overLimit })).toThrow(
      /over the limit of 2048 bytes[\s\S]*accessToken/,
    );
  });

  it("bounds the Simlock agent token and names the field", () => {
    const base = { kind: "simlock", id: "lock", label: "Simlock", gatewayUrl: "https://g.example" };
    expect(decodeSimlock({ ...base, agentToken: atLimit }).agentToken).toBe(atLimit);
    expect(() => decodeSimlock({ ...base, agentToken: overLimit })).toThrow(
      /over the limit of 2048 bytes[\s\S]*agentToken/,
    );
  });
});

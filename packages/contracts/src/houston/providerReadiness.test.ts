import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerProvider } from "../server.ts";
import { ProviderReadiness } from "./providerReadiness.ts";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeReadiness = Schema.decodeUnknownSync(ProviderReadiness);

// An upstream-shaped snapshot: every required key, no `readiness`.
const upstreamProvider = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-29T12:00:00.000Z",
  models: [],
};

describe("readiness decoding", () => {
  it("decodes a ServerProvider without readiness", () => {
    const provider = decodeProvider(upstreamProvider);
    expect("readiness" in provider).toBe(false);
  });

  it("decodes each of the six states on a ServerProvider", () => {
    const states = [
      { state: "notInstalled", reason: "missing", message: "Codex was not found" },
      { state: "notInstalled", reason: "unusable", message: "Codex failed to run" },
      { state: "turnedOff", message: "Codex is turned off in Settings" },
      { state: "signedOut", source: "probe", message: "Codex is signed out" },
      { state: "signedOut", source: "turn", message: "Credentials expired." },
      {
        state: "rejected",
        code: "subscription_sharing_v2_user_not_eligible",
        message: "ChatGPT sharing is unavailable for this account or workspace.",
        at: "2026-10-29T12:00:00.000Z",
      },
      {
        state: "outOfUsage",
        resetsAt: "2026-10-29T18:00:00.000Z",
        message: "Claude usage limit reached.",
        at: "2026-10-29T12:00:00.000Z",
      },
      {
        state: "outOfUsage",
        resetsAt: null,
        message: "OpenCode did not say when its limit resets",
        at: "2026-10-29T12:00:00.000Z",
      },
      { state: "ready" },
    ];
    for (const readiness of states) {
      expect(decodeProvider({ ...upstreamProvider, readiness }).readiness).toEqual(readiness);
    }
  });

  it("rejects a state outside the six", () => {
    expect(() =>
      decodeProvider({
        ...upstreamProvider,
        readiness: { state: "degraded", message: "Codex is slow" },
      }),
    ).toThrow();
    expect(() => decodeReadiness({ state: "degraded", message: "Codex is slow" })).toThrow();
  });

  it("rejects a rejected code longer than 128 characters and accepts 128", () => {
    const rejected = {
      state: "rejected",
      message: "Refused.",
      at: "2026-10-29T12:00:00.000Z",
    };
    expect(decodeReadiness({ ...rejected, code: "x".repeat(128) })).toMatchObject({
      code: "x".repeat(128),
    });
    expect(() => decodeReadiness({ ...rejected, code: "x".repeat(129) })).toThrow();
  });

  it("rejects an empty or oversized message", () => {
    expect(() => decodeReadiness({ state: "turnedOff", message: "  " })).toThrow();
    expect(() => decodeReadiness({ state: "turnedOff", message: "x".repeat(4_097) })).toThrow();
    expect(decodeReadiness({ state: "turnedOff", message: "x".repeat(4_096) })).toMatchObject({
      state: "turnedOff",
    });
  });
});

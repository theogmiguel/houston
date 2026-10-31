import { describe, expect, it } from "@effect/vitest";

import { presentConnectionDiagnosis } from "./diagnosis.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  type ConnectionAttemptError,
  type SupervisorConnectionState,
} from "./model.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";

const backoff = (lastFailure: ConnectionAttemptError): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "backoff",
  attempt: 3,
  lastFailure,
  retryAt: Date.UTC(2026, 9, 19, 12, 0, 30),
});

const diagnose = (state: SupervisorConnectionState) =>
  presentConnectionDiagnosis({ hostLabel: "Mac mini", state });

const results = (state: SupervisorConnectionState) =>
  diagnose(state)?.hops.map((hop) => `${hop.hop}:${hop.result}`);

describe("presentConnectionDiagnosis", () => {
  it("blames this device's network when the fetch never reaches the host", () => {
    const failure = mapRemoteEnvironmentError(
      new RemoteEnvironmentAuthFetchError({ message: "Failed to fetch", cause: new TypeError() }),
    );
    const diagnosis = diagnose(backoff(failure));
    expect(diagnosis?.headline).toBe("Houston on Mac mini did not answer");
    expect(diagnosis?.hops).toHaveLength(2);
  });

  it("reports this device as offline before any other hop", () => {
    const failure = mapRemoteEnvironmentError(
      new RemoteEnvironmentAuthFetchError({ message: "Failed to fetch", cause: new TypeError() }),
    );
    const state = { ...backoff(failure), network: "offline" as const };
    expect(diagnose(state)?.headline).toBe("This device is offline");
    expect(results(state)?.[0]).toBe("device:failed");
  });

  it("names an older host as the failed hop", () => {
    const failure = new ConnectionBlockedError({
      reason: "unsupported",
      detail: "Update the host",
      serverUpdateRequired: true,
    });
    expect(diagnose(backoff(failure))?.headline).toBe("Mac mini runs an older Houston");
    expect(results(backoff(failure))).toEqual(["device:ok", "server:failed"]);
  });

  it("returns null while nothing has failed", () => {
    expect(diagnose(AVAILABLE_CONNECTION_STATE)).toBeNull();
  });
});

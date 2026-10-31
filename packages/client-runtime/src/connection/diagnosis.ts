import * as DateTime from "effect/DateTime";

import type {
  ConnectionAttemptError,
  ConnectionHop,
  SupervisorConnectionState,
} from "./model.ts";

export type ConnectionHopResult = "ok" | "failed" | "unchecked";

export interface ConnectionDiagnosisHop {
  readonly hop: ConnectionHop;
  readonly label: string;
  readonly result: ConnectionHopResult;
}

export interface ConnectionDiagnosis {
  /** Names the part that failed, e.g. "Houston on Mac mini did not answer". */
  readonly headline: string;
  readonly hops: ReadonlyArray<ConnectionDiagnosisHop>;
  readonly steps: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<readonly [label: string, value: string]>;
  /** Kept for the shared web and mobile render model; direct routes have no guide. */
  readonly moreInfoUrl: string | null;
}

export interface ConnectionDiagnosisInput {
  readonly hostLabel: string;
  readonly state: SupervisorConnectionState;
  readonly clientVersion?: string | undefined;
  readonly serverVersion?: string | null | undefined;
}

interface Located {
  readonly hop: ConnectionHop;
  readonly cause: "offline" | "outdated" | "unreachable" | null;
}

function locate(input: ConnectionDiagnosisInput): Located | null {
  const failure = input.state.lastFailure;
  if (input.state.network === "offline" || input.state.phase === "offline") {
    return { hop: "device", cause: "offline" };
  }
  if (failure?._tag === "ConnectionBlockedError" && failure.serverUpdateRequired) {
    return { hop: "server", cause: "outdated" };
  }
  if (failure?.hop !== undefined) {
    return { hop: failure.hop, cause: null };
  }
  if (failure !== null) {
    return { hop: "server", cause: "unreachable" };
  }
  return null;
}

function headline(host: string, located: Located, failure: ConnectionAttemptError | null): string {
  switch (located.cause) {
    case "offline":
      return "This device is offline";
    case "outdated":
      return `${host} runs an older Houston`;
    case "unreachable":
      return `${host} did not answer`;
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return "This device could not prepare the connection";
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? `Houston on ${host} did not accept this device`
        : `Houston on ${host} did not answer`;
  }
}

function steps(host: string, located: Located, failure: ConnectionAttemptError | null): string[] {
  switch (located.cause) {
    case "offline":
      return ["Connect this device to the internet. Houston reconnects on its own."];
    case "outdated":
      return [`Update Houston on ${host}.`];
    case "unreachable":
      return [`Make sure ${host} is awake and online.`, `Make sure Houston is running on ${host}.`];
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return [
        "Restart Houston on this device.",
        `If it keeps failing, remove ${host} from this device and add it again.`,
      ];
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? [`Remove ${host} from this device and add it again.`]
        : [
            `Make sure Houston is running on ${host}.`,
            "Retry. If it keeps failing, copy the diagnostics.",
          ];
  }
}

const HOP_ORDER: ReadonlyArray<ConnectionHop> = ["device", "server"];

function hopLabel(hop: ConnectionHop, host: string): string {
  switch (hop) {
    case "device":
      return "This device";
    case "server":
      return `Houston on ${host}`;
  }
}

/**
 * Turns a connection state into what failed, in order, and what to try. Returns
 * null when nothing has failed. Web and mobile render this same model.
 */
export function presentConnectionDiagnosis(
  input: ConnectionDiagnosisInput,
): ConnectionDiagnosis | null {
  const located = locate(input);
  if (located === null) return null;
  const host = input.hostLabel;
  const failure = input.state.lastFailure;
  const failedIndex = HOP_ORDER.indexOf(located.hop);
  const hops = HOP_ORDER.map((hop, index): ConnectionDiagnosisHop => ({
    hop,
    label: hopLabel(hop, host),
    result: index < failedIndex ? "ok" : index === failedIndex ? "failed" : "unchecked",
  }));

  const facts: Array<readonly [string, string]> = [];
  const add = (label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") facts.push([label, String(value)]);
  };
  add("Cause", located.cause ?? failure?.reason);
  add("HTTP status", failure?.httpStatus);
  add("Attempts", input.state.attempt > 0 ? input.state.attempt : null);
  add(
    "Next retry",
    input.state.retryAt === null
      ? null
      : DateTime.formatIso(DateTime.makeUnsafe(input.state.retryAt)),
  );
  add("Route", "Direct");
  add("App version", input.clientVersion);
  add("Host version", input.serverVersion);
  add("Error", failure?.detail);
  add("Trace ID", failure?.traceId);

  return {
    headline: headline(host, located, failure),
    hops,
    steps: steps(host, located, failure),
    facts,
    moreInfoUrl: null,
  };
}

const HOP_MARK = { ok: "ok", failed: "FAILED", unchecked: "not checked" } as const;

/** One plain-text block for bug reports. */
export function connectionDiagnosisText(hostLabel: string, diagnosis: ConnectionDiagnosis): string {
  return [
    `Houston connection to ${hostLabel}: ${diagnosis.headline}`,
    "",
    ...diagnosis.hops.map((hop) => `${hop.label}: ${HOP_MARK[hop.result]}`),
    "",
    ...diagnosis.facts.map(([label, value]) => `${label}: ${value}`),
    ...(diagnosis.moreInfoUrl ? ["", `More info: ${diagnosis.moreInfoUrl}`] : []),
  ].join("\n");
}

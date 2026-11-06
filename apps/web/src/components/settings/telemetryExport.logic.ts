import type { ObservabilitySettings, OtlpSignal } from "@houston-app/contracts";
import {
  DATADOG_AGENT_DEFAULT,
  type DatadogSite,
  type HoustonObservabilityPreset,
} from "@houston-app/contracts/houston/observability";

export type TelemetryDestination = "off" | "otlp" | "datadog" | "datadog-agent";

export const DESTINATION_LABELS: Record<TelemetryDestination, string> = {
  off: "Off",
  otlp: "OTLP endpoints",
  datadog: "Datadog",
  "datadog-agent": "Datadog Agent on this machine",
};

export const DATADOG_SITE_LABELS: Record<DatadogSite, string> = {
  "datadoghq.com": "US1 · datadoghq.com",
  "us3.datadoghq.com": "US3 · us3.datadoghq.com",
  "us5.datadoghq.com": "US5 · us5.datadoghq.com",
  "datadoghq.eu": "EU1 · datadoghq.eu",
  "ap1.datadoghq.com": "AP1 · ap1.datadoghq.com",
  "ap2.datadoghq.com": "AP2 · ap2.datadoghq.com",
  "uk1.datadoghq.com": "UK1 · uk1.datadoghq.com",
};

/** What each Datadog signal sends, for its toggle's tooltip. */
export const DATADOG_SIGNAL_DESCRIPTIONS: Record<OtlpSignal, string> = {
  traces:
    "Span names and timings, Houston's ids, outcomes and error types, request hosts and SQL statements with placeholders.",
  metrics:
    "Counters and timings such as runs, requests and queue waits, labelled by provider and outcome.",
  logs: "Log levels, times, ids and error types. No message text is sent.",
};

const URL_KEYS = ["otlpTracesUrl", "otlpMetricsUrl", "otlpLogsUrl"] as const;

type Observability = Pick<ObservabilitySettings, (typeof URL_KEYS)[number]> & {
  readonly preset?: HoustonObservabilityPreset | null | undefined;
};

/** The settings patch for observability: only the fields that change. */
export interface ObservabilityPatch {
  otlpTracesUrl?: string;
  otlpMetricsUrl?: string;
  otlpLogsUrl?: string;
  preset?: HoustonObservabilityPreset | null;
}

// An endpoint set by the environment or the desktop over empty settings reads as OTLP endpoints,
// so its row and Test button stay visible.
export const destinationOf = (
  settings: Observability,
  overridden = false,
): TelemetryDestination => {
  if (settings.preset?._tag === "Datadog") return "datadog";
  if (settings.preset?._tag === "DatadogAgent") return "datadog-agent";
  return overridden || URL_KEYS.some((key) => settings[key].trim() !== "") ? "otlp" : "off";
};

/** The preset a destination starts from: the saved one when it matches, else the defaults. */
export const initialPreset = (
  destination: TelemetryDestination,
  saved: HoustonObservabilityPreset | null | undefined,
): HoustonObservabilityPreset | null => {
  if (destination === "datadog") {
    return saved?._tag === "Datadog"
      ? saved
      : {
          _tag: "Datadog",
          site: "datadoghq.com",
          signals: { traces: true, metrics: false, logs: false },
        };
  }
  if (destination === "datadog-agent") {
    return saved?._tag === "DatadogAgent"
      ? saved
      : { _tag: "DatadogAgent", ...DATADOG_AGENT_DEFAULT };
  }
  return null;
};

const samePreset = (
  left: HoustonObservabilityPreset | null | undefined,
  right: HoustonObservabilityPreset | null | undefined,
) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

// The settings patch for a destination. A preset clears the URL fields, so a signal it does not
// export goes nowhere rather than to an endpoint chosen earlier; Off clears everything.
export const observabilityPatch = (
  saved: Observability,
  destination: TelemetryDestination,
  preset: HoustonObservabilityPreset | null,
  urls: Pick<ObservabilitySettings, (typeof URL_KEYS)[number]>,
): ObservabilityPatch | null => {
  const patch: ObservabilityPatch = {};
  if (destination === "otlp") {
    for (const key of URL_KEYS) {
      if (urls[key].trim() !== saved[key]) patch[key] = urls[key].trim();
    }
    if (saved.preset != null) patch.preset = null;
  } else {
    for (const key of URL_KEYS) {
      if (saved[key] !== "") patch[key] = "";
    }
    if (destination === "off") {
      if (saved.preset != null) patch.preset = null;
    } else if (!samePreset(saved.preset, preset)) {
      patch.preset = preset;
    }
  }
  return Object.keys(patch).length === 0 ? null : patch;
};

/** The intake URL the Test button checks for a Datadog signal. */
export const datadogIntakeUrl = (site: DatadogSite, signal: OtlpSignal) =>
  `https://otlp.${site}/v1/${signal}`;

/** A Datadog rejection names the two things a 403 usually means. */
export const rejectedLabel = (status: number, destination: TelemetryDestination) =>
  destination === "datadog" && status === 403
    ? `Rejected · HTTP 403 (check the site and API key)`
    : `Rejected · HTTP ${status}`;

const KEY_SHAPE = /^[0-9a-fA-F]{32}$/;

/** Why a typed key would be refused, or null; it mirrors the server's check. */
export const datadogKeyProblem = (key: string): string | null => {
  const trimmed = key.trim();
  if (trimmed === "") return null;
  return KEY_SHAPE.test(trimmed)
    ? null
    : `A Datadog API key is 32 hexadecimal characters; this one has ${trimmed.length}.`;
};

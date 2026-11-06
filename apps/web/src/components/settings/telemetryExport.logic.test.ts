import { DEFAULT_SERVER_SETTINGS } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  datadogIntakeUrl,
  datadogKeyProblem,
  destinationOf,
  initialPreset,
  observabilityPatch,
  rejectedLabel,
} from "./telemetryExport.logic";

const EMPTY = DEFAULT_SERVER_SETTINGS.observability;
const URLS = { ...EMPTY, otlpTracesUrl: "http://collector/v1/traces" };
const DATADOG = {
  _tag: "Datadog",
  site: "datadoghq.eu",
  signals: { traces: true, metrics: false, logs: false },
} as const;
const AGENT = { _tag: "DatadogAgent", host: "127.0.0.1", port: 4318 } as const;

describe("telemetry export destination", () => {
  it("reads the saved destination", () => {
    expect(destinationOf(EMPTY)).toBe("off");
    expect(destinationOf(EMPTY, true)).toBe("otlp");
    expect(destinationOf(URLS)).toBe("otlp");
    expect(destinationOf({ ...URLS, preset: DATADOG })).toBe("datadog");
    expect(destinationOf({ ...EMPTY, preset: AGENT })).toBe("datadog-agent");
    expect(destinationOf({ ...URLS, preset: null })).toBe("otlp");
  });

  it("starts Datadog with traces on and metrics and logs off, and keeps a saved preset", () => {
    expect(initialPreset("datadog", null)).toEqual({
      _tag: "Datadog",
      site: "datadoghq.com",
      signals: { traces: true, metrics: false, logs: false },
    });
    expect(initialPreset("datadog", DATADOG)).toBe(DATADOG);
    expect(initialPreset("datadog-agent", DATADOG)).toEqual(AGENT);
    expect(initialPreset("off", DATADOG)).toBeNull();
  });
});

describe("telemetry export patch", () => {
  it("Off clears the URLs and the preset", () => {
    expect(observabilityPatch({ ...URLS, preset: DATADOG }, "off", null, URLS)).toEqual({
      otlpTracesUrl: "",
      preset: null,
    });
    expect(observabilityPatch(EMPTY, "off", null, EMPTY)).toBeNull();
  });

  it("a Datadog destination stores its preset and clears the URL fields", () => {
    expect(observabilityPatch(URLS, "datadog", DATADOG, URLS)).toEqual({
      otlpTracesUrl: "",
      preset: DATADOG,
    });
    expect(observabilityPatch({ ...EMPTY, preset: DATADOG }, "datadog", DATADOG, EMPTY)).toBeNull();
    expect(
      observabilityPatch({ ...EMPTY, preset: DATADOG }, "datadog-agent", AGENT, EMPTY),
    ).toEqual({ preset: AGENT });
  });

  it("OTLP endpoints send only changed URLs and drop a saved preset", () => {
    expect(
      observabilityPatch({ ...EMPTY, preset: DATADOG }, "otlp", null, {
        ...EMPTY,
        otlpLogsUrl: " http://collector/v1/logs ",
      }),
    ).toEqual({ otlpLogsUrl: "http://collector/v1/logs", preset: null });
  });
});

describe("telemetry export checks", () => {
  it("tests the site's intake", () => {
    expect(datadogIntakeUrl("us5.datadoghq.com", "metrics")).toBe(
      "https://otlp.us5.datadoghq.com/v1/metrics",
    );
  });

  it("explains a Datadog 403", () => {
    expect(rejectedLabel(403, "datadog")).toBe("Rejected · HTTP 403 (check the site and API key)");
    expect(rejectedLabel(403, "otlp")).toBe("Rejected · HTTP 403");
  });

  it("names a key of the wrong shape without repeating it", () => {
    expect(datadogKeyProblem("")).toBeNull();
    expect(datadogKeyProblem("0123456789abcdef0123456789abcdef")).toBeNull();
    const problem = datadogKeyProblem("secret-token");
    expect(problem).toContain("has 12");
    expect(problem).not.toContain("secret-token");
  });
});

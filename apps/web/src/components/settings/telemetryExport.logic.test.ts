import { DEFAULT_SERVER_SETTINGS } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentDraftOf,
  datadogIntakeUrl,
  datadogKeyProblem,
  datadogKeyStatusLabel,
  destinationOf,
  initialPreset,
  observabilityPatch,
  parseAgentDraft,
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

describe("Datadog Agent fields", () => {
  it("keep every intermediate value the user types, and report what blocks saving", () => {
    const draft = agentDraftOf(AGENT);
    expect(draft).toEqual({ host: "127.0.0.1", port: "4318" });
    // Backspacing the port through "431", "43", "4" and "" keeps each value as typed.
    for (const port of ["431", "43", "4"]) {
      expect(parseAgentDraft({ ...draft, port })).toEqual({
        _tag: "Valid",
        preset: { ...AGENT, port: Number(port) },
      });
    }
    expect(parseAgentDraft({ ...draft, port: "" })).toEqual({
      _tag: "Invalid",
      problem: "Enter the Agent's OTLP port, from 1 to 65535.",
    });
    expect(parseAgentDraft({ ...draft, port: "70000" })._tag).toBe("Invalid");
    expect(parseAgentDraft({ ...draft, port: "43.5" })._tag).toBe("Invalid");
    // An emptied host stays empty instead of snapping back to the default.
    expect(parseAgentDraft({ ...draft, host: "" })).toEqual({
      _tag: "Invalid",
      problem: "Enter the Agent's host, such as 127.0.0.1.",
    });
    expect(parseAgentDraft({ host: " agent.local ", port: " 4317 " })).toEqual({
      _tag: "Valid",
      preset: { _tag: "DatadogAgent", host: "agent.local", port: 4317 },
    });
  });
});

describe("Datadog Agent host", () => {
  const port = "4318";
  const problem =
    "Enter only the Agent's host name or IP address, such as 127.0.0.1, without a scheme, port or path.";
  it("refuses a scheme, port, path or whitespace, which would build a broken URL", () => {
    for (const host of [
      "localhost:4318",
      "http://127.0.0.1",
      "127.0.0.1/v1",
      "agent local",
      "user@agent.local",
      "[::1]",
      "::1]:4318",
      "agent.local?x",
      // IPv6-shaped inputs whose brackets close early and point the URL at another host.
      "a:b]@evil.com#[",
      "1:2]@evil.com/[::1",
      "::1]/x?[",
    ]) {
      expect(parseAgentDraft({ host, port }), host).toEqual({ _tag: "Invalid", problem });
    }
  });

  it("accepts host names, IPv4 and bare IPv6 addresses", () => {
    for (const host of [
      "127.0.0.1",
      "localhost",
      "Agent.Local",
      "dd-agent.internal",
      "::1",
      "fe80::1",
    ]) {
      expect(parseAgentDraft({ host, port })._tag, host).toBe("Valid");
    }
  });
});

describe("Datadog API key status", () => {
  it("names a refused status query instead of showing nothing", () => {
    expect(datadogKeyStatusLabel({ data: { present: true }, error: null })).toBe("Saved");
    expect(datadogKeyStatusLabel({ data: { present: false }, error: null })).toBe("Not set");
    expect(datadogKeyStatusLabel({ data: null, error: null })).toBe("Checking…");
    expect(datadogKeyStatusLabel({ data: null, error: "This server has no secret store." })).toBe(
      "Unavailable",
    );
  });
});

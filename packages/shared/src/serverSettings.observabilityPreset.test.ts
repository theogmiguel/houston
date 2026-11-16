import { DEFAULT_SERVER_SETTINGS } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyServerSettingsPatch,
  parsePersistedServerObservabilitySettings,
} from "./serverSettings.ts";

const DATADOG = {
  _tag: "Datadog",
  site: "datadoghq.eu",
  signals: { traces: true, metrics: false, logs: false },
} as const;
const AGENT = { _tag: "DatadogAgent", host: "127.0.0.1", port: 4318 } as const;

describe("observability preset", () => {
  it("replaces the stored preset whole and removes it with null", () => {
    const datadog = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      observability: { preset: DATADOG },
    });
    const agent = applyServerSettingsPatch(datadog, { observability: { preset: AGENT } });
    expect(agent.observability.preset).toEqual(AGENT);
    const off = applyServerSettingsPatch(agent, {
      observability: { preset: null, otlpTracesUrl: "" },
    });
    expect(off.observability.preset).toBeNull();
  });

  it("explains a preset it ignores and keeps the other observability settings", () => {
    const parsed = parsePersistedServerObservabilitySettings(
      JSON.stringify({
        observability: {
          otlpMetricsUrl: "http://127.0.0.1:4318/v1/metrics",
          preset: { ...DATADOG, site: "us2.ddog-gov.com" },
        },
      }),
    );
    expect(parsed.preset).toBeUndefined();
    expect(parsed.otlpMetricsUrl).toBe("http://127.0.0.1:4318/v1/metrics");
    expect(parsed.presetWarning).toContain('"us2.ddog-gov.com"');
    expect(parsed.presetWarning).toContain("datadoghq.com, us3.datadoghq.com");
  });
});

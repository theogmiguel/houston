import { describe, expect, it } from "vite-plus/test";
import type { InferenceThreadLastRequest } from "@houston-app/contracts/houston/inference";
import { InferenceServerId } from "@houston-app/contracts/houston/inference";

import {
  MISSING_MEASUREMENT,
  cachedPromptShare,
  formatLastInferenceRequest,
  formatMeasuredSeconds,
  formatTokensPerSecond,
} from "./inferenceMetrics.ts";

const last: InferenceThreadLastRequest = {
  serverId: InferenceServerId.make("rtx"),
  model: "glm",
  completedAt: "2026-11-07T00:00:00.000Z",
  promptTokens: 12_300,
  cachedPromptTokens: 9_840,
  completionTokens: 400,
  queueWaitMs: 400,
  ttftMs: 1_200,
  decodeTokensPerSecond: 35,
};

describe("inference metrics", () => {
  it("formats missing and measured durations", () => {
    expect(formatMeasuredSeconds(null)).toBe(MISSING_MEASUREMENT);
    expect(formatMeasuredSeconds(1_200)).toBe("1.2 s");
    expect(formatMeasuredSeconds(50)).toBe("0.05 s");
  });

  it("formats decode speed", () => {
    expect(formatTokensPerSecond(null)).toBe(MISSING_MEASUREMENT);
    expect(formatTokensPerSecond(9.5)).toBe("9.5 tok/s");
    expect(formatTokensPerSecond(35)).toBe("35 tok/s");
  });

  it("computes a bounded cached share", () => {
    expect(cachedPromptShare(10, 4)).toBe(0.4);
    expect(cachedPromptShare(0, 4)).toBeNull();
    expect(cachedPromptShare(10, null)).toBeNull();
    expect(cachedPromptShare(10, 20)).toBe(1);
  });

  it("summarizes the last request", () => {
    expect(formatLastInferenceRequest(last)).toBe(
      "Last request: 12.3K prompt tokens (80% cached) · TTFT 1.2 s · 35 tok/s · waited 0.4 s",
    );
  });
});

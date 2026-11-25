import { describe, expect, it } from "vite-plus/test";
import type { InferenceUsageRow } from "@houston-app/contracts/houston/inference";

import { groupLocalCompute, sumLocalCompute } from "./UsageLocalCompute.logic.ts";

const distribution = (p50: number | null) => ({ n: p50 === null ? 0 : 1, p50, p95: p50 });

const row = (overrides: Partial<InferenceUsageRow>): InferenceUsageRow => ({
  serverId: "rtx" as never,
  model: "glm",
  purpose: "interactive",
  requests: 1,
  failed: 0,
  promptTokens: 100,
  cachedPromptTokens: 50,
  completionTokens: 10,
  queueWaitMs: distribution(10),
  ttftMs: distribution(100),
  decodeTokensPerSecond: distribution(40),
  ...overrides,
});

describe("local compute", () => {
  it("sums token and request totals", () => {
    expect(
      sumLocalCompute([row({}), row({ requests: 2, failed: 1, completionTokens: 5 })]),
    ).toEqual({
      requests: 3,
      failed: 1,
      promptTokens: 200,
      cachedPromptTokens: 100,
      completionTokens: 15,
    });
  });

  it("groups by server and model, busiest first, with purposes in order", () => {
    const groups = groupLocalCompute(
      [
        row({ model: "glm", purpose: "background" }),
        row({ model: "glm", purpose: "interactive", requests: 3 }),
        row({ serverId: "spark" as never, model: "llama", requests: 2 }),
      ],
      [{ id: "rtx" as never, displayName: "RTX", models: [] } as never],
    );
    expect(groups.map((group) => [group.serverName, group.model, group.totals.requests])).toEqual([
      ["RTX", "glm", 4],
      ["spark", "llama", 2],
    ]);
    expect(groups[0]!.rows.map((entry) => entry.purpose)).toEqual(["interactive", "background"]);
  });
});

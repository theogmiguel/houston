import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveAssistantModelAttribution } from "./assistantModelAttribution";

const claude = ProviderInstanceId.make("claude");

const provider: ServerProvider = {
  instanceId: claude,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-30T00:00:00.000Z",
  models: [
    { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", isCustom: false, capabilities: null },
  ],
  skills: [],
  slashCommands: [],
};

const run = {
  id: "run-1",
  providerInstanceId: claude,
  modelSelection: { instanceId: claude, model: "claude-sonnet-4-6" },
};

describe("resolveAssistantModelAttribution", () => {
  it("names the provider and the model the answer's run used", () => {
    expect(
      resolveAssistantModelAttribution({ runs: [run], runId: "run-1", providers: [provider] }),
    ).toEqual({ providerDisplayName: "Claude", modelLabel: "Sonnet 4.6" });
  });

  it("falls back to the raw slugs when the provider has not reported its catalog", () => {
    expect(
      resolveAssistantModelAttribution({ runs: [run], runId: "run-1", providers: null }),
    ).toEqual({ providerDisplayName: "claude", modelLabel: "claude-sonnet-4-6" });
  });

  it("has no attribution for an answer whose run or model is unknown", () => {
    expect(
      resolveAssistantModelAttribution({ runs: [], runId: "run-1", providers: [provider] }),
    ).toBeNull();
    expect(
      resolveAssistantModelAttribution({ runs: [run], runId: null, providers: [provider] }),
    ).toBeNull();
    expect(
      resolveAssistantModelAttribution({
        runs: [{ ...run, modelSelection: { instanceId: claude, model: "" } }],
        runId: "run-1",
        providers: [provider],
      }),
    ).toBeNull();
  });
});

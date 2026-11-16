import { describe, expect, it } from "vite-plus/test";

import { resolveFollowUpDispatch } from "./composerDispatch.ts";

describe("resolveFollowUpDispatch", () => {
  it("queues a steer that the provider cannot redirect instead of losing it", () => {
    expect(
      resolveFollowUpDispatch({
        running: true,
        alternateModifier: false,
        activeTurnDefault: "steer",
        providerSupportsActiveSteering: false,
      }),
    ).toEqual({ mode: "queue", queuedBecauseProviderCannotSteer: true });
  });

  it("steers when the provider can redirect an active run", () => {
    expect(
      resolveFollowUpDispatch({
        running: true,
        alternateModifier: false,
        activeTurnDefault: "steer",
        providerSupportsActiveSteering: true,
      }),
    ).toEqual({ mode: "steer", queuedBecauseProviderCannotSteer: false });
  });

  it("keeps a queue default quiet when the provider cannot steer", () => {
    expect(
      resolveFollowUpDispatch({
        running: true,
        alternateModifier: false,
        activeTurnDefault: "queue",
        providerSupportsActiveSteering: false,
      }),
    ).toEqual({ mode: "queue", queuedBecauseProviderCannotSteer: false });
  });

  it("queues and notices an alternate steer the provider cannot satisfy", () => {
    expect(
      resolveFollowUpDispatch({
        running: true,
        alternateModifier: true,
        activeTurnDefault: "queue",
        providerSupportsActiveSteering: false,
      }),
    ).toEqual({ mode: "queue", queuedBecauseProviderCannotSteer: true });
  });

  it("blames compaction rather than the provider when steering is already blocked", () => {
    expect(
      resolveFollowUpDispatch({
        running: true,
        alternateModifier: false,
        activeTurnDefault: "steer",
        canSteer: false,
        providerSupportsActiveSteering: true,
      }),
    ).toEqual({ mode: "queue", queuedBecauseProviderCannotSteer: false });
  });

  it("leaves an idle send alone", () => {
    expect(
      resolveFollowUpDispatch({
        running: false,
        alternateModifier: false,
        activeTurnDefault: "steer",
        providerSupportsActiveSteering: false,
      }),
    ).toEqual({ mode: "auto", queuedBecauseProviderCannotSteer: false });
  });
});

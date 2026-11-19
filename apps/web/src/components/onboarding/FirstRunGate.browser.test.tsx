import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { FirstRunGate } from "./FirstRunGate";

// The gate reads six atoms in render order; the sequence repeats so a rerender
// reads the same evidence as the last one.
vi.mock("@effect/atom-react", async (original) => {
  const actual = await original<typeof import("@effect/atom-react")>();
  const values = [
    0,
    null,
    { environment: { environmentId: "local" }, cwd: null },
    null,
    true,
    true,
  ];
  let index = 0;
  return { ...actual, useAtomValue: () => values[index++ % values.length] };
});

vi.mock("../../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../../hooks/useSettings")>()),
  useClientSettingsHydrationStatus: () => "ready",
  useClientSettings: (selector: (settings: { onboardingCompletedAt: string | null }) => unknown) =>
    selector({ onboardingCompletedAt: null }),
  ensureClientSettingsHydrated: async () => undefined,
}));

vi.mock("../../onboarding/firstRun", () => ({
  completeOnboarding: async () => undefined,
}));

vi.mock("../../onboarding/firstRun.logic", async (original) => ({
  ...(await original<typeof import("../../onboarding/firstRun.logic")>()),
  resolveFirstRunDecision: () => ({ decision: "wizard", persistCompletion: false }),
}));

vi.mock("../../state/entities", () => ({
  useAllEnvironmentShellsBootstrapped: () => true,
  useProjects: () => [],
}));

vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironments: () => ({ isReady: true }),
}));

describe("FirstRunGate", () => {
  it("renders the app at home for the first-run wizard instead of leaving for /welcome", async () => {
    await using screen = await render(
      <FirstRunGate enabled hostedStatic={false}>
        <div>board</div>
      </FirstRunGate>,
      { router: "/" },
    );

    await expect.element(page.getByText("board")).toBeInTheDocument();
    expect(screen.router?.state.location.pathname).toBe("/");
  });
});

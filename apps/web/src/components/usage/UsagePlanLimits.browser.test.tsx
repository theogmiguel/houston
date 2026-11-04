import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@houston-app/contracts";
import type { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const presentations = vi.hoisted(() => ({
  atom: null as unknown as Atom.Writable<unknown>,
}));

vi.mock(import("../../state/presentation"), async () => {
  const { Atom } = await import("effect/reactivity");
  presentations.atom = Atom.make(new Map()) as never;
  return {
    environmentPresentations: { presentationsWithProvidersAtom: presentations.atom },
    environmentSummaries: {},
    useEnvironmentPresentation: () => ({ isReady: false, presentation: null }),
  } as never;
});

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { render } from "../../../test/render";
import { UsagePlanLimits } from "./UsagePlanLimits";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const CHECKED_AT = "2026-10-31T11:58:00.000Z";
const ENVIRONMENT = EnvironmentId.make("desk");

function provider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex_work"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "ChatGPT Work",
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated", email: "work@example.com", label: "Pro" },
    checkedAt: CHECKED_AT,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: CHECKED_AT,
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          usedPercent: 90,
          resetsAt: "2026-10-31T13:00:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 100,
          resetsAt: "2026-11-04T12:00:00.000Z",
          windowDurationMins: 10_080,
        },
      ],
    },
  };
}

async function show(providers: readonly ServerProvider[]) {
  const map = new Map([
    [
      ENVIRONMENT,
      {
        entry: { target: { label: "Desk" } },
        serverConfig: { providers },
      },
    ],
  ]);
  appAtomRegistry.set(presentations.atom as never, map as never);
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <UsagePlanLimits selectedEnvironmentIds={null} hiddenProviders={new Set()} now={NOW} />
    </RegistryContext.Provider>,
  );
}

it("says so when no selected provider reports limits", async () => {
  await using screen = await show([]);

  await expect.element(screen.getByText("Plan limits")).toBeVisible();
  await expect
    .element(
      screen.getByText("No provider on the selected environments reports subscription limits."),
    )
    .toBeVisible();
});

it("fills the meter, remaining share and reset window from the reported limits", async () => {
  await using screen = await show([provider()]);

  await expect.element(screen.getByText("Codex")).toBeVisible();
  await expect.element(screen.getByText("Pro")).toBeVisible();
  await expect.element(screen.getByText("Session")).toBeVisible();
  await expect.element(screen.getByText("10%")).toBeVisible();
  await expect.element(screen.getByText("Weekly")).toBeVisible();
  await expect.element(screen.getByText("0%")).toBeVisible();
  await expect.element(screen.getByText(/Resets in 1h 0m · ahead of pace/)).toBeVisible();
  await expect.element(screen.getByText(/updated 2m ago/)).toBeVisible();
});

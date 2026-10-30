import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ModelPickerSidebar } from "./ModelPickerSidebar";

function provider(patch: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-30T00:00:00.000Z",
    models: [],
    skills: [],
    slashCommands: [],
    ...patch,
  };
}

const signedOut = provider({
  instanceId: ProviderInstanceId.make("antigravity"),
  driver: ProviderDriverKind.make("antigravity"),
  displayName: "Antigravity",
  status: "error",
  auth: { status: "unauthenticated" },
  message: "Sign in with Google to use Antigravity.",
});

function sidebar(selected: ProviderInstanceId) {
  return (
    <TooltipProvider delay={0}>
      <ModelPickerSidebar
        selectedInstanceId={selected}
        onSelectInstance={() => {}}
        onFocusSearch={() => {}}
        instanceEntries={deriveProviderInstanceEntries([provider(), signedOut])}
        showFavorites={false}
      />
    </TooltipProvider>
  );
}

it("keeps an unavailable provider in the list and says why", async () => {
  await using screen = await render(sidebar(ProviderInstanceId.make("claude")));

  const antigravity = screen.container.querySelector<HTMLElement>(
    '[data-model-picker-provider="antigravity"]',
  );
  expect(antigravity?.textContent).toContain("Antigravity");
  expect(antigravity?.textContent).toContain("Sign in with Google to use Antigravity.");
  expect(antigravity?.querySelector("button")?.disabled).toBe(true);
});

it("gives only the unavailable provider a reason line", async () => {
  await using screen = await render(sidebar(ProviderInstanceId.make("claude")));

  const reasons = screen.container.querySelectorAll("[data-model-picker-provider-reason]");
  expect(reasons).toHaveLength(1);

  const ready = screen.container.querySelector('[data-model-picker-provider="claude"]');
  expect(ready?.textContent).toBe("Claude");
});

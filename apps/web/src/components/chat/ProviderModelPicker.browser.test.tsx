import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@houston-app/contracts";
import { compileResolvedKeybindingsConfig } from "@houston-app/shared/keybindings";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { TooltipProvider } from "../ui/tooltip";
import { ProviderModelPicker } from "./ProviderModelPicker";

const CLAUDE = ProviderInstanceId.make("claude");
const CLAUDE_KIND = ProviderDriverKind.make("claudeAgent");

const effort: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "effort",
  label: "Effort",
  type: "select",
  currentValue: "high",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
  ],
};

const provider: ServerProvider = {
  instanceId: CLAUDE,
  driver: CLAUDE_KIND,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-30T00:00:00.000Z",
  models: [
    {
      slug: "opus",
      name: "Claude Opus 5.5",
      isCustom: false,
      capabilities: { optionDescriptors: [effort] },
    },
  ],
  skills: [],
  slashCommands: [],
};

const entries = deriveProviderInstanceEntries([provider]);

it("draws the left half of the split control as the model name", async () => {
  await using _screen = await render(
    <TooltipProvider delay={0}>
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={CLAUDE}
        model="opus"
        lockedProvider={null}
        instanceEntries={entries}
        keybindings={compileResolvedKeybindingsConfig([])}
        modelOptionsByInstance={new Map([[CLAUDE, provider.models]])}
        isComposerOwned
        split="start"
        onInstanceModelChange={() => {}}
      />
    </TooltipProvider>,
    { router: false },
  );

  const trigger = page.getByRole("button", { name: /Opus 5\.5/ });
  await expect.element(trigger).toBeVisible();
  expect(trigger.element().className).toContain("rounded-e-none");
});

it("caps the composer's model trigger so a long model name truncates", async () => {
  const longName = "Fusion (Claude Opus 5.5 Medium + SWE-2 High) Bypass Permissions";
  const longProvider: ServerProvider = {
    ...provider,
    models: [{ ...provider.models[0]!, slug: "fusion", name: longName }],
  };
  await using _screen = await render(
    <TooltipProvider delay={0}>
      <div style={{ width: 760 }}>
        <ProviderModelPicker
          environmentId={null}
          activeInstanceId={CLAUDE}
          model="fusion"
          lockedProvider={null}
          instanceEntries={deriveProviderInstanceEntries([longProvider])}
          keybindings={compileResolvedKeybindingsConfig([])}
          modelOptionsByInstance={new Map([[CLAUDE, longProvider.models]])}
          isComposerOwned
          onInstanceModelChange={() => {}}
        />
      </div>
    </TooltipProvider>,
    { router: false },
  );

  const trigger = page.getByRole("button", { name: longName });
  await expect.element(trigger).toBeVisible();
  // 14rem: the trigger stops growing there and the label truncates.
  expect(trigger.element().getBoundingClientRect().width).toBeLessThanOrEqual(224);
});

it("draws the provider's mark beside the model name", async () => {
  await using _screen = await render(
    <TooltipProvider delay={0}>
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={CLAUDE}
        model="opus"
        lockedProvider={null}
        instanceEntries={entries}
        keybindings={compileResolvedKeybindingsConfig([])}
        modelOptionsByInstance={new Map([[CLAUDE, provider.models]])}
        isComposerOwned
        onInstanceModelChange={() => {}}
      />
    </TooltipProvider>,
    { router: false },
  );

  const trigger = page.getByRole("button", { name: /Opus 5\.5/ });
  await expect.element(trigger).toBeVisible();
  const icon = trigger.element().querySelector("[data-chat-provider-model-picker-icon] svg");
  expect(icon).not.toBeNull();
  expect(icon!.getBoundingClientRect().width).toBeGreaterThan(0);
});

it("opens the model menu at one fixed height however few models the provider lists", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  await using _screen = await render(
    <TooltipProvider delay={0}>
      <div style={{ paddingTop: 420 }}>
        <ProviderModelPicker
          environmentId={null}
          activeInstanceId={CLAUDE}
          model="opus"
          lockedProvider={null}
          instanceEntries={entries}
          keybindings={compileResolvedKeybindingsConfig([])}
          modelOptionsByInstance={new Map([[CLAUDE, provider.models]])}
          onInstanceModelChange={() => {}}
        />
      </div>
    </TooltipProvider>,
    { router: false },
  );

  await page.getByRole("button", { name: /Opus 5\.5/ }).click();
  const content = () => document.querySelector<HTMLElement>('[data-model-picker-content="true"]');
  await expect.poll(() => content()?.getBoundingClientRect().height).toBe(346);
});

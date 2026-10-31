import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { TraitsPicker } from "./TraitsPicker";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => compileResolvedKeybindingsConfig([])) as never,
}));

const PROVIDER = ProviderDriverKind.make("claudeAgent");
const INSTANCE = ProviderInstanceId.make("claude");
const MODEL = "claude-opus-5-5";

const effortDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "effort",
  label: "Effort",
  type: "select",
  currentValue: "high",
  promptInjectedValues: ["ultrathink"],
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra High" },
    { id: "max", label: "Max" },
    { id: "ultrathink", label: "Ultrathink" },
  ],
};

const contextWindowDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "contextWindow",
  label: "Context window",
  type: "select",
  currentValue: "200k",
  options: [
    { id: "200k", label: "200k", isDefault: true },
    { id: "1m", label: "1M" },
  ],
};

const xhighEffortDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  ...effortDescriptor,
  currentValue: "xhigh",
};

const models = [
  {
    slug: MODEL,
    name: "Claude Opus 5.5",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        effortDescriptor,
        contextWindowDescriptor,
        { id: "fastMode", label: "Fast mode", type: "boolean" as const, currentValue: false },
      ],
    },
  },
];

const xhighModels = [
  {
    ...models[0]!,
    capabilities: {
      optionDescriptors: [
        xhighEffortDescriptor,
        contextWindowDescriptor,
        { id: "fastMode", label: "Fast mode", type: "boolean" as const, currentValue: false },
      ],
    },
  },
];

it("draws the traits menu as the board does", async () => {
  await using _screen = await render(
    <TooltipProvider delay={0}>
      <TraitsPicker
        provider={PROVIDER}
        instanceId={INSTANCE}
        models={models}
        model={MODEL}
        promptUltrathink="none"
        onPromptEdit={() => {}}
        modelOptions={[]}
        planModeEnabled={false}
        isComposerOwned
        effortDisplay="label"
        onModelOptionsChange={() => {}}
      />
    </TooltipProvider>,
    { router: false },
  );

  await page.getByRole("button", { name: /Effort:/ }).click();

  for (const label of ["Low", "Med", "High", "Xhigh", "Max"]) {
    await expect.element(page.getByRole("menuitemradio", { name: label })).toBeVisible();
  }

  await expect.element(page.getByRole("menuitemcheckbox", { name: "Fast mode" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: /Context window 200k/ })).toBeVisible();
  await expect.element(page.getByRole("menuitemcheckbox", { name: "Ultrathink" })).toBeVisible();
});

it("shortens Xhigh to Xh on the compact trigger and effort segment", async () => {
  const container = document.createElement("div");
  container.className = "@container/composer-surface";
  container.style.width = "480px";
  await using _screen = await render(
    <TooltipProvider delay={0}>
      <TraitsPicker
        provider={PROVIDER}
        instanceId={INSTANCE}
        models={xhighModels}
        model={MODEL}
        promptUltrathink="none"
        onPromptEdit={() => {}}
        modelOptions={[]}
        planModeEnabled={false}
        isComposerOwned
        effortDisplay="label"
        size="xs"
        onModelOptionsChange={() => {}}
      />
    </TooltipProvider>,
    { container, router: false },
  );

  const trigger = page.getByRole("button", { name: /Effort:/ });
  await expect.element(trigger).toBeVisible();
  expect(trigger.element().textContent).toContain("Xh");
  await trigger.click();
  await expect.element(page.getByRole("menuitemradio", { name: "Xh" })).toBeVisible();
  await expect.element(page.getByRole("menuitemradio", { name: "Xhigh" })).not.toBeInTheDocument();
});

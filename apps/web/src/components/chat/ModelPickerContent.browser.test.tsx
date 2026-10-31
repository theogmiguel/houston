import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { TooltipProvider } from "../ui/tooltip";
import { ModelPickerContent } from "./ModelPickerContent";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => compileResolvedKeybindingsConfig([])) as never,
}));

vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentModelPreferences: () => ({ favorites: [], providerModelPreferences: {} }),
  useToggleEnvironmentModelFavorite: () => async () => {},
}));

const CLAUDE = ProviderInstanceId.make("claude");
const CLAUDE_KIND = ProviderDriverKind.make("claudeAgent");
const EFFECT = {
  id: "effort",
  label: "Effort",
  type: "select" as const,
  currentValue: "high",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
  ],
};

function effortOptions(): ReadonlyArray<ProviderOptionDescriptor> {
  return [
    EFFECT,
    {
      id: "contextWindow",
      label: "Context window",
      type: "select",
      currentValue: "200k",
      options: [{ id: "200k", label: "200k", isDefault: true }],
    },
  ];
}

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
      capabilities: { optionDescriptors: effortOptions() },
    },
    {
      slug: "sonnet",
      name: "Claude Sonnet 5.5",
      isCustom: false,
      capabilities: { optionDescriptors: effortOptions() },
    },
    {
      slug: "haiku-legacy",
      name: "Claude Haiku 3",
      isCustom: false,
      isLegacy: true,
      capabilities: { optionDescriptors: effortOptions() },
    },
  ],
  skills: [],
  slashCommands: [],
};

const entries = deriveProviderInstanceEntries([provider]);
const modelOptionsByInstance = new Map(
  entries.map((entry) => [entry.instanceId, entry.models] as const),
);

it("draws the multi-model footer, search hint and collapsed legacy section", async () => {
  const container = document.createElement("div");
  container.style.width = "520px";
  container.style.height = "520px";
  const onSendSelectedModels = vi.fn();
  const searchInputRef = createRef<HTMLInputElement>();

  await using _screen = await render(
    <TooltipProvider delay={0}>
      <ModelPickerContent
        environmentId={null}
        activeInstanceId={CLAUDE}
        model="opus"
        selectedModels={[
          { instanceId: CLAUDE, model: "opus" },
          { instanceId: CLAUDE, model: "sonnet" },
        ]}
        onToggleModel={() => {}}
        onSendSelectedModels={onSendSelectedModels}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={modelOptionsByInstance}
        terminalOpen={false}
        onInstanceModelChange={() => {}}
        searchInputRef={searchInputRef}
      />
    </TooltipProvider>,
    { container },
  );

  await expect.element(page.getByPlaceholder("Search models · Shift click adds")).toBeVisible();
  await expect.element(page.getByText("2 models selected")).toBeVisible();
  await expect.element(page.getByText("Legacy models · 1")).toBeVisible();

  await page.getByRole("button", { name: "Send to 2" }).click();
  expect(onSendSelectedModels).toHaveBeenCalledOnce();
});

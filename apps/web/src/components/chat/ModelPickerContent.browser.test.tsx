import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@houston-app/contracts";
import { compileResolvedKeybindingsConfig } from "@houston-app/shared/keybindings";
import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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
const CODEX = ProviderInstanceId.make("codex");
const CODEX_KIND = ProviderDriverKind.make("codex");
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

const codexProvider: ServerProvider = {
  instanceId: CODEX,
  driver: CODEX_KIND,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-30T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5-6-luna",
      name: "GPT-5.6 Luna",
      isCustom: false,
      capabilities: { optionDescriptors: effortOptions() },
    },
  ],
  skills: [],
  slashCommands: [],
};

const entries = deriveProviderInstanceEntries([provider, codexProvider]);
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

  await expect.element(page.getByPlaceholder("Search models…")).toBeVisible();
  await expect.element(page.getByText("Shift-click adds a model")).toBeVisible();
  await expect.element(page.getByText("200k · High").first()).toBeVisible();
  await expect.element(page.getByText("2 models selected")).toBeVisible();
  await expect.element(page.getByText("Show more · 1")).toBeVisible();

  await page.getByRole("button", { name: "Send to 2" }).click();
  expect(onSendSelectedModels).toHaveBeenCalledOnce();
});

it("keeps cross-provider selected models in the open provider tab", async () => {
  const container = document.createElement("div");
  container.style.width = "520px";
  container.style.height = "520px";
  const searchInputRef = createRef<HTMLInputElement>();

  await using _screen = await render(
    <TooltipProvider delay={0}>
      <ModelPickerContent
        environmentId={null}
        activeInstanceId={CLAUDE}
        model="opus"
        selectedModels={[
          { instanceId: CLAUDE, model: "opus" },
          { instanceId: CODEX, model: "gpt-5-6-luna" },
        ]}
        onToggleModel={() => {}}
        onSendSelectedModels={() => {}}
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

  const crossProviderRow = page.getByRole("option", { name: /GPT-5\.6 Luna/ });
  await expect.element(crossProviderRow).toBeVisible();
  expect(crossProviderRow.element().textContent).toContain("Codex");

  await page.getByRole("button", { name: "Codex" }).click();
  await expect.element(page.getByRole("option", { name: /GPT-5\.6 Luna/ })).toBeVisible();
  await expect.element(page.getByRole("option", { name: /Claude Opus 5\.5/ })).toBeVisible();
});

it("states the reasoning effort only on the selected model row", async () => {
  const container = document.createElement("div");
  container.style.width = "520px";
  container.style.height = "520px";
  const searchInputRef = createRef<HTMLInputElement>();

  await using _screen = await render(
    <TooltipProvider delay={0}>
      <ModelPickerContent
        environmentId={null}
        activeInstanceId={CLAUDE}
        model="opus"
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

  const selected = page.getByRole("option", { name: /Opus 5\.5/ });
  const other = page.getByRole("option", { name: /Sonnet 5\.5/ });
  await expect.element(selected).toBeVisible();
  await expect.element(other).toBeVisible();
  expect(selected.element().textContent).toContain("200k · High");
  expect(other.element().textContent).toContain("200k");
  expect(other.element().textContent).not.toContain("High");
});

const JUMP_KEYBINDINGS = compileResolvedKeybindingsConfig([
  { key: "mod+1", command: "modelPicker.jump.1" },
]);

function pickerContent(input: { model?: string; keybindings?: boolean } = {}) {
  const container = document.createElement("div");
  container.style.width = "520px";
  container.style.height = "520px";
  return render(
    <TooltipProvider delay={0}>
      <ModelPickerContent
        environmentId={null}
        activeInstanceId={CLAUDE}
        model={input.model ?? "opus"}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={modelOptionsByInstance}
        {...(input.keybindings ? { keybindings: JUMP_KEYBINDINGS } : {})}
        terminalOpen={false}
        onInstanceModelChange={() => {}}
        searchInputRef={createRef<HTMLInputElement>()}
      />
    </TooltipProvider>,
    { container },
  );
}

const rowNames = () =>
  Array.from(document.querySelectorAll('[role="option"]'), (row) =>
    row.querySelector("span.truncate")?.textContent?.trim(),
  );

it("drops the provider prefix from model names inside a provider's tab", async () => {
  await using _screen = await pickerContent();
  await expect.element(page.getByRole("option", { name: /Opus 5\.5/ })).toBeVisible();
  expect(rowNames()).toEqual(expect.arrayContaining(["Opus 5.5", "Sonnet 5.5"]));
  expect(rowNames()).not.toContain("Claude Opus 5.5");
});

it("keeps the full model name in search results", async () => {
  await using _screen = await pickerContent();
  await userEvent.type(page.getByPlaceholder(/search/i).element() as HTMLElement, "opus");
  await expect.element(page.getByRole("option", { name: /Claude Opus 5\.5/ })).toBeVisible();
});

it("keeps the full model name under Favorites", async () => {
  await using _screen = await pickerContent();
  await page.getByRole("button", { name: "Favorites" }).click();
  expect(rowNames()).not.toContain("Opus 5.5");
});

it("shows the jump hints at rest, without holding a modifier", async () => {
  await using _screen = await pickerContent({ keybindings: true });
  await expect.element(page.getByRole("option", { name: /Opus 5\.5/ })).toBeVisible();
  const hints = document.querySelectorAll<HTMLElement>('[role="option"] kbd');
  // One binding (mod+1): only the first row has a jump hint, and it is drawn.
  expect(hints).toHaveLength(1);
  expect(getComputedStyle(hints[0]!).visibility).toBe("visible");
  expect(hints[0]!.textContent?.trim()).not.toBe("");
  // The hint sits at the far right of its row, after the model name.
  const row = hints[0]!.closest<HTMLElement>('[role="option"]')!;
  const name = row.querySelector<HTMLElement>("span.truncate")!;
  expect(hints[0]!.getBoundingClientRect().left).toBeGreaterThan(
    name.getBoundingClientRect().right,
  );
  expect(row.getBoundingClientRect().right - hints[0]!.getBoundingClientRect().right).toBeLessThan(
    16,
  );
});

it("gives each provider tab an accessible name, with Favorites first", async () => {
  await using _screen = await pickerContent();
  const tabs = Array.from(
    document.querySelectorAll<HTMLElement>("[data-model-picker-sidebar] button"),
  );
  expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
    "Favorites",
    "Claude",
    "Codex",
  ]);
  // Icon-only: no visible label beside the mark.
  for (const tab of tabs) expect(tab.textContent?.trim()).toBe("");
  expect(tabs.find((tab) => tab.getAttribute("aria-label") === "Claude")!.ariaPressed).toBe("true");
});

it("marks the selected model with a check right after its name, and only that model", async () => {
  await using _screen = await pickerContent();
  const selected = page.getByRole("option", { name: /Opus 5\.5/ });
  await expect.element(selected).toBeVisible();
  const check = selected.element().querySelector<SVGElement>(".lucide-check")!;
  expect(check).not.toBeNull();
  const name = selected.element().querySelector<HTMLElement>("span.truncate")!;
  const gap = check.getBoundingClientRect().left - name.getBoundingClientRect().right;
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(16);
  const other = page.getByRole("option", { name: /Sonnet 5\.5/ });
  expect(other.element().querySelector(".lucide-check")).toBeNull();
});

it("words the legacy group as Show more and Show less", async () => {
  await using _screen = await pickerContent();
  const toggle = page.getByText(/^Show more/);
  await expect.element(toggle).toBeVisible();
  await toggle.click();
  await expect.element(page.getByText(/^Show less/)).toBeVisible();
});

it("sizes the model list to the models the open provider offers", async () => {
  const container = document.createElement("div");
  container.style.width = "520px";
  container.style.height = "520px";
  const searchInputRef = createRef<HTMLInputElement>();

  await using _screen = await render(
    <TooltipProvider delay={0}>
      <ModelPickerContent
        environmentId={null}
        activeInstanceId={CLAUDE}
        model="opus"
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

  const listHeight = () =>
    container.querySelector<HTMLElement>("[data-model-picker-list]")!.getBoundingClientRect()
      .height;
  await expect.element(page.getByRole("option", { name: /Opus 5\.5/ })).toBeVisible();
  const claudeHeight = listHeight();

  await page.getByRole("button", { name: "Codex" }).click();
  await expect.element(page.getByRole("option", { name: /GPT-5\.6 Luna/ })).toBeVisible();
  expect(listHeight(), "one-model provider list height").toBeLessThan(claudeHeight);
});

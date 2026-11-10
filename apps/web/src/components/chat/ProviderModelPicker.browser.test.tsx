import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@houston-app/contracts";
import type { RuntimeMode } from "@houston-app/contracts";
import { compileResolvedKeybindingsConfig } from "@houston-app/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { runtimeModeConfig, runtimeModeOptions } from "./runtimeModeConfig";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ComposerEffortPanel, ComposerPickerFooter } from "../ui/composer-model-effort";
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

it("names the model in full in the trigger and without the provider prefix in its tab", async () => {
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
  const label = trigger.element().querySelector("[data-chat-provider-model-picker-label]");
  expect(label?.textContent).toBe("Claude Opus 5.5");

  await trigger.click();
  await expect.element(page.getByRole("option", { name: /Opus 5\.5/ })).toBeVisible();
  expect(document.querySelector('[role="option"] span.truncate')?.textContent?.trim()).toBe(
    "Opus 5.5",
  );
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

it("sizes the model menu to its rows instead of a fixed height", async () => {
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
  // One model: the search field and one row beside the provider column, well under eight rows.
  await expect
    .poll(() => content()?.getBoundingClientRect().height ?? 0)
    .toBeLessThan(8 * 34 + 120);
  await expect.poll(() => content()?.getBoundingClientRect().height ?? 0).toBeGreaterThan(60);
});

it("docks an effort panel under the list and stays open after a model pick", async () => {
  const twoModels: ServerProvider = {
    ...provider,
    models: [
      provider.models[0]!,
      {
        slug: "sonnet",
        name: "Claude Sonnet 5.5",
        isCustom: false,
        capabilities: { optionDescriptors: [effort] },
      },
    ],
  };
  const changes: Array<{ instanceId: ProviderInstanceId; model: string }> = [];
  await using _screen = await render(
    <TooltipProvider delay={0}>
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={CLAUDE}
        model="opus"
        lockedProvider={null}
        instanceEntries={deriveProviderInstanceEntries([twoModels])}
        keybindings={compileResolvedKeybindingsConfig([])}
        modelOptionsByInstance={new Map([[CLAUDE, twoModels.models]])}
        isComposerOwned
        effortPanel={
          <div>
            <button type="button" data-effort-level={true} aria-checked="true">
              High
            </button>
          </div>
        }
        onInstanceModelChange={(instanceId, model) => {
          changes.push({ instanceId, model });
        }}
      />
    </TooltipProvider>,
    { router: false },
  );

  await page.getByRole("button", { name: /Opus 5\.5/ }).click();
  await expect.poll(() => document.querySelector("[data-model-picker-effort]") !== null).toBe(true);

  await page.getByRole("option", { name: /Sonnet 5\.5/ }).click();

  await expect.poll(() => changes.length).toBe(1);
  expect(changes[0]?.model).toBe("sonnet");
  // The docked picker stays open so the effort level can change in the same popup.
  await expect
    .poll(() => document.querySelector("[data-model-picker-content]") !== null)
    .toBe(true);
});

it("lines the docked popup up with the composer card and titles the effort panel without the model name", async () => {
  await page.viewport(1440, 900);
  await using _screen = await render(
    <TooltipProvider delay={0}>
      <div style={{ paddingTop: 120, paddingLeft: 160 }}>
        <div
          data-inline-resting-controls="true"
          style={{ width: 640, padding: "12px 32px" }}
          className="rounded-xl border border-border"
        >
          <ProviderModelPicker
            environmentId={null}
            activeInstanceId={CLAUDE}
            model="opus"
            lockedProvider={null}
            instanceEntries={entries}
            keybindings={compileResolvedKeybindingsConfig([])}
            modelOptionsByInstance={new Map([[CLAUDE, provider.models]])}
            isComposerOwned
            effortPanel={<ComposerEffortPanel traits={null} />}
            onInstanceModelChange={() => {}}
          />
        </div>
      </div>
    </TooltipProvider>,
    { router: false },
  );

  await page.getByRole("button", { name: /Opus 5\.5/ }).click();
  await expect.poll(() => document.querySelector("[data-model-picker-effort]") !== null).toBe(true);

  const panel = document.querySelector<HTMLElement>("[data-model-picker-effort]")!;
  // The label names the setting only: the selected model is already shown in the list above it.
  expect(panel.textContent).toContain("Effort");
  expect(panel.textContent).not.toContain("Claude Opus 5.5");

  await expect
    .poll(() => {
      const card = document.querySelector<HTMLElement>('[data-inline-resting-controls="true"]');
      const popup = document.querySelector<HTMLElement>('[data-slot="popover-positioner"]');
      if (!card || !popup) return null;
      return Math.round(popup.getBoundingClientRect().left - card.getBoundingClientRect().left);
    })
    .toBe(0);
});

it("leaves out the effort band when the model has no effort levels", async () => {
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
        showEffortPanel={false}
        effortPanel={<ComposerEffortPanel traits={null} />}
        onInstanceModelChange={() => {}}
      />
    </TooltipProvider>,
    { router: false },
  );

  await page.getByRole("button", { name: /Opus 5\.5/ }).click();
  await expect
    .poll(() => document.querySelector("[data-model-picker-content]") !== null)
    .toBe(true);
  expect(document.querySelector("[data-model-picker-effort]")).toBeNull();
});

describe("the docked popup's shape", () => {
  const panelButtons = (
    <div>
      <button type="button" data-effort-row data-effort-level aria-checked="true">
        Low
      </button>
      <button type="button" data-effort-row data-effort-level aria-checked="false">
        High
      </button>
    </div>
  );

  async function openDocked() {
    await page.viewport(1440, 900);
    const screen = await render(
      <TooltipProvider delay={0}>
        <div style={{ paddingTop: 480, paddingLeft: 160 }}>
          <div data-inline-resting-controls="true" style={{ width: 640, padding: "12px 32px" }}>
            <ProviderModelPicker
              environmentId={null}
              activeInstanceId={CLAUDE}
              model="opus"
              lockedProvider={null}
              instanceEntries={entries}
              keybindings={compileResolvedKeybindingsConfig([])}
              modelOptionsByInstance={new Map([[CLAUDE, provider.models]])}
              isComposerOwned
              effortPanel={panelButtons}
              onInstanceModelChange={() => {}}
            />
          </div>
        </div>
      </TooltipProvider>,
      { router: false },
    );
    await page.getByRole("button", { name: /Opus 5\.5/ }).click();
    await expect
      .poll(() => document.querySelector("[data-model-picker-effort]") !== null)
      .toBe(true);
    return screen;
  }

  const rect = (selector: string) =>
    document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();

  it("is one 428px frame with the list over the effort panel", async () => {
    await using _screen = await openDocked();

    const frame = () =>
      document.querySelector<HTMLElement>('[data-model-picker-content="true"]')!.parentElement!;
    await expect.poll(() => Math.round(frame().getBoundingClientRect().width)).toBe(428);
    const list = rect('[data-model-picker-content="true"]');
    const panel = rect("[data-model-picker-effort]");
    expect(panel.top).toBeGreaterThanOrEqual(list.bottom - 1);
    // Both fill the frame inside its 1px border.
    expect(Math.round(list.width)).toBe(426);
    expect(Math.round(panel.width)).toBe(426);
  });

  it("has no footer when the strip holds the permissions", async () => {
    await using _screen = await openDocked();

    expect(document.body.textContent).not.toContain("Full access");
    expect(document.querySelector("[data-composer-permissions-trigger]")).toBeNull();
  });

  it("returns from the first effort row to the search field with Up or Left", async () => {
    await using _screen = await openDocked();
    const search = document.querySelector<HTMLInputElement>("[data-model-picker-content] input")!;
    const first = document.querySelector<HTMLElement>("[data-effort-row]")!;

    first.focus();
    await userEvent.keyboard("{ArrowUp}");
    await expect.poll(() => document.activeElement === search).toBe(true);

    first.focus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect.poll(() => document.activeElement === search).toBe(true);
  });
});

describe("docked popup and the composer context row", () => {
  async function openDocked(paddingTop: number) {
    await page.viewport(1440, 900);
    const screen = await render(
      <TooltipProvider delay={0}>
        <form data-chat-composer-form="true" style={{ width: 760, marginLeft: 160, paddingTop }}>
          <div
            data-inline-resting-controls="true"
            style={{ padding: "12px 32px" }}
            className="rounded-xl border border-border"
          >
            <ProviderModelPicker
              environmentId={null}
              activeInstanceId={CLAUDE}
              model="opus"
              lockedProvider={null}
              instanceEntries={entries}
              keybindings={compileResolvedKeybindingsConfig([])}
              modelOptionsByInstance={new Map([[CLAUDE, provider.models]])}
              isComposerOwned
              effortPanel={<ComposerEffortPanel traits={null} />}
              onInstanceModelChange={() => {}}
            />
          </div>
        </form>
      </TooltipProvider>,
      { router: false },
    );
    await page.getByRole("button", { name: /Opus 5\.5/ }).click();
    await expect
      .poll(() => document.querySelector("[data-model-picker-effort]") !== null)
      .toBe(true);
    return screen;
  }

  function rects() {
    const card = document.querySelector<HTMLElement>('[data-inline-resting-controls="true"]')!;
    const popup = document.querySelector<HTMLElement>('[data-slot="popover-positioner"]')!;
    return {
      card: card.getBoundingClientRect(),
      popup: popup.getBoundingClientRect(),
    };
  }

  it("falls back below the card when there is not enough room above", async () => {
    await using _screen = await openDocked(20);

    expect(rects().popup.top).toBeGreaterThanOrEqual(rects().card.bottom);
  });

  it("opens above the card when there is room above", async () => {
    await using _screen = await openDocked(560);

    await expect.poll(() => rects().popup.bottom <= rects().card.top).toBe(true);
  });

  it.each([1440, 800])(
    "opens above the composer without covering the draft hero in a %ipx pane",
    async (width) => {
      await page.viewport(width, 900);
      await using _screen = await render(
        <TooltipProvider delay={0}>
          <div data-chat-column="">
            <div
              data-testid="draft-hero"
              style={{ height: 72, paddingLeft: 160 }}
              className="text-3xl"
            >
              What should we build in atlas-api?
            </div>
            <form
              data-chat-composer-form="true"
              style={{ width: Math.min(760, width - 40), marginLeft: 20, paddingTop: 560 }}
            >
              <div
                data-inline-resting-controls="true"
                style={{ padding: "12px 32px" }}
                className="rounded-xl border border-border"
              >
                <ProviderModelPicker
                  environmentId={null}
                  activeInstanceId={CLAUDE}
                  model="opus"
                  lockedProvider={null}
                  instanceEntries={entries}
                  keybindings={compileResolvedKeybindingsConfig([])}
                  modelOptionsByInstance={new Map([[CLAUDE, provider.models]])}
                  isComposerOwned
                  effortPanel={<ComposerEffortPanel traits={null} />}
                  onInstanceModelChange={() => {}}
                />
              </div>
            </form>
          </div>
        </TooltipProvider>,
        { router: false },
      );
      await page.getByRole("button", { name: /Opus 5\.5/ }).click();
      await expect
        .poll(() => document.querySelector("[data-model-picker-effort]") !== null)
        .toBe(true);

      await expect
        .poll(() => {
          const card = document.querySelector<HTMLElement>(
            '[data-inline-resting-controls="true"]',
          )!;
          const popup = document.querySelector<HTMLElement>('[data-slot="popover-positioner"]')!;
          return popup.getBoundingClientRect().bottom <= card.getBoundingClientRect().top;
        })
        .toBe(true);
      const hero = document.querySelector<HTMLElement>('[data-testid="draft-hero"]')!;
      const popup = document.querySelector<HTMLElement>('[data-slot="popover-positioner"]')!;
      expect(popup.getBoundingClientRect().top).toBeGreaterThan(
        hero.getBoundingClientRect().bottom,
      );
    },
  );

  it("opens under the card on the new-thread page even when the list must scroll", async () => {
    await page.viewport(1440, 900);
    await using _screen = await render(
      <TooltipProvider delay={0}>
        <div data-chat-column="" data-draft-hero="">
          <form
            data-chat-composer-form="true"
            style={{ width: 760, marginLeft: 20, paddingTop: 620 }}
          >
            <div data-inline-resting-controls="true" className="rounded-xl border border-border">
              <ProviderModelPicker
                environmentId={null}
                activeInstanceId={CLAUDE}
                model="opus"
                lockedProvider={null}
                instanceEntries={entries}
                keybindings={compileResolvedKeybindingsConfig([])}
                modelOptionsByInstance={new Map([[CLAUDE, provider.models]])}
                isComposerOwned
                effortPanel={<ComposerEffortPanel traits={null} />}
                onInstanceModelChange={() => {}}
              />
            </div>
          </form>
        </div>
      </TooltipProvider>,
      { router: false },
    );
    await page.getByRole("button", { name: /Opus 5\.5/ }).click();
    await expect
      .poll(() => {
        const card = document.querySelector<HTMLElement>('[data-inline-resting-controls="true"]')!;
        const popup = document.querySelector<HTMLElement>('[data-slot="popover-positioner"]');
        return (
          popup !== null && popup.getBoundingClientRect().top >= card.getBoundingClientRect().bottom
        );
      })
      .toBe(true);
  });

  it("puts the providers in a column beside the models", async () => {
    await page.viewport(1440, 900);
    await using _screen = await render(
      <TooltipProvider delay={0}>
        <form
          data-chat-composer-form="true"
          style={{ width: 760, marginLeft: 20, paddingTop: 500 }}
        >
          <div data-inline-resting-controls="true" className="rounded-xl border border-border">
            <ProviderModelPicker
              environmentId={null}
              activeInstanceId={CLAUDE}
              model="opus"
              lockedProvider={null}
              instanceEntries={entries}
              keybindings={compileResolvedKeybindingsConfig([])}
              modelOptionsByInstance={new Map([[CLAUDE, provider.models]])}
              isComposerOwned
              effortPanel={<ComposerEffortPanel traits={null} />}
              onInstanceModelChange={() => {}}
            />
          </div>
        </form>
      </TooltipProvider>,
      { router: false },
    );
    await page.getByRole("button", { name: /Opus 5\.5/ }).click();
    await expect
      .poll(() => document.querySelector("[data-model-picker-content]") !== null)
      .toBe(true);
    const content = document.querySelector<HTMLElement>("[data-model-picker-content]")!;
    const search = content.querySelector<HTMLElement>("input")!;
    const sidebar = content.querySelector<HTMLElement>("[data-model-picker-sidebar]")!;
    expect(sidebar.getBoundingClientRect().right).toBeLessThanOrEqual(
      search.getBoundingClientRect().left,
    );
  });

  it("never extends above the header of its column", async () => {
    await page.viewport(1440, 900);
    await using _screen = await render(
      <TooltipProvider delay={0}>
        <div data-chat-column="">
          <header data-chat-header="" style={{ height: 44 }} />
          <form
            data-chat-composer-form="true"
            style={{ width: 760, marginLeft: 160, paddingTop: 480 }}
          >
            <div
              data-inline-resting-controls="true"
              style={{ padding: "12px 32px" }}
              className="rounded-xl border border-border"
            >
              <ProviderModelPicker
                environmentId={null}
                activeInstanceId={CLAUDE}
                model="opus"
                lockedProvider={null}
                instanceEntries={entries}
                keybindings={compileResolvedKeybindingsConfig([])}
                modelOptionsByInstance={new Map([[CLAUDE, provider.models]])}
                isComposerOwned
                effortPanel={<ComposerEffortPanel traits={null} />}
                onInstanceModelChange={() => {}}
              />
            </div>
          </form>
        </div>
      </TooltipProvider>,
      { router: false },
    );
    await page.getByRole("button", { name: /Opus 5\.5/ }).click();
    await expect
      .poll(() => document.querySelector("[data-model-picker-effort]") !== null)
      .toBe(true);

    const header = document.querySelector<HTMLElement>("[data-chat-header]")!;
    await expect
      .poll(() => {
        const popup = document.querySelector<HTMLElement>('[data-slot="popover-positioner"]')!;
        return popup.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
      })
      .toBeGreaterThanOrEqual(8);
  });
});

describe("Ultracode in the picker's footer", () => {
  const ultracode: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
    id: "ultracode",
    label: "Ultracode",
    type: "boolean",
    currentValue: false,
  };
  const ultracodeProvider: ServerProvider = {
    ...provider,
    models: [
      {
        slug: "opus",
        name: "Claude Opus 5.5",
        isCustom: false,
        capabilities: { optionDescriptors: [effort, ultracode] },
      },
    ],
  };
  const permissionChanges: RuntimeMode[] = [];
  const permissions = {
    runtimeMode: "approval-required" as const,
    runtimeModeOptions: runtimeModeOptions.map((mode) => ({
      mode,
      ...runtimeModeConfig[mode],
      ...(mode === "full-access" ? { disabledReason: "Full access is off here." } : {}),
    })),
    onRuntimeModeChange: (mode: RuntimeMode) => {
      permissionChanges.push(mode);
    },
  };

  async function openPicker(withPermissions: boolean) {
    await page.viewport(1440, 900);
    const models = ultracodeProvider.models;
    const screen = await render(
      <TooltipProvider delay={0}>
        <div style={{ paddingTop: 480, paddingLeft: 160 }}>
          <div data-inline-resting-controls="true" style={{ width: 640, padding: "12px 32px" }}>
            <ProviderModelPicker
              environmentId={null}
              activeInstanceId={CLAUDE}
              model="opus"
              lockedProvider={null}
              instanceEntries={deriveProviderInstanceEntries([ultracodeProvider])}
              keybindings={compileResolvedKeybindingsConfig([])}
              modelOptionsByInstance={new Map([[CLAUDE, models]])}
              isComposerOwned
              effortPanel={<ComposerEffortPanel traits={null} />}
              footer={
                <ComposerPickerFooter
                  traits={{
                    provider: CLAUDE_KIND,
                    instanceId: CLAUDE,
                    models,
                    model: "opus",
                    modelOptions: undefined,
                    planModeEnabled: false,
                    onModelOptionsChange: () => {},
                  }}
                  {...(withPermissions ? { permissions } : {})}
                />
              }
              onInstanceModelChange={() => {}}
            />
          </div>
        </div>
      </TooltipProvider>,
      { router: false },
    );
    await page.getByRole("button", { name: /Opus 5\.5/ }).click();
    await expect
      .poll(() => document.querySelector("[data-model-picker-effort]") !== null)
      .toBe(true);
    return screen;
  }

  it("shows the toggle inside the picker beside Permissions", async () => {
    await using _screen = await openPicker(true);
    const toggle = page.getByRole("button", { name: "Ultracode" }).element();
    const frame = document.querySelector<HTMLElement>(
      '[data-model-picker-content="true"]',
    )!.parentElement!;
    expect(frame.contains(toggle)).toBe(true);
    expect(frame.querySelector("[data-composer-permissions-trigger]")).toBeNull();
    expect(frame.querySelector('[role="radiogroup"][aria-label="Permissions"]')).not.toBeNull();
    const list = document.querySelector<HTMLElement>('[data-model-picker-content="true"]')!;
    expect(toggle.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      list.getBoundingClientRect().bottom,
    );
  });

  it("keeps the toggle when the new-thread strip holds the permissions", async () => {
    await using _screen = await openPicker(false);
    expect(page.getByRole("button", { name: "Ultracode" }).element()).toBeTruthy();
    expect(document.querySelector("[data-composer-permissions]")).toBeNull();
  });

  it("names the current mode in muted text beside four icon-only segments", async () => {
    await using _screen = await openPicker(true);
    const group = page.getByRole("radiogroup", { name: "Permissions" });
    await expect.element(group).toBeVisible();
    const radios = Array.from(group.element().querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual(
      runtimeModeOptions.map((mode) => runtimeModeConfig[mode].label),
    );
    for (const radio of radios) expect(radio.textContent).toBe("");
    const label = document.querySelector<HTMLElement>("[data-composer-permissions-label]")!;
    expect(label.textContent).toBe(runtimeModeConfig["approval-required"].label);
    expect(label.getBoundingClientRect().right).toBeLessThanOrEqual(
      group.element().getBoundingClientRect().left,
    );
    expect(radios.filter((radio) => radio.getAttribute("aria-checked") === "true")).toHaveLength(1);
  });

  it("previews a mode's name on hover and focus", async () => {
    await using _screen = await openPicker(true);
    const label = () =>
      document.querySelector<HTMLElement>("[data-composer-permissions-label]")!.textContent;
    await userEvent.hover(page.getByRole("radio", { name: "Auto-accept edits" }));
    await expect.poll(label).toBe("Auto-accept edits");
    await userEvent.unhover(page.getByRole("radio", { name: "Auto-accept edits" }));
    await expect.poll(label).toBe(runtimeModeConfig["approval-required"].label);
  });

  it("applies a pick with one click and keeps the popup open", async () => {
    permissionChanges.length = 0;
    await using _screen = await openPicker(true);
    await userEvent.click(page.getByRole("radio", { name: "Auto-accept edits" }));
    expect(permissionChanges).toEqual(["auto-accept-edits"]);
    expect(document.querySelector("[data-model-picker-content]")).not.toBeNull();
  });

  it("moves focus with Left and Right and refuses a disabled mode", async () => {
    permissionChanges.length = 0;
    await using _screen = await openPicker(true);
    const checked = page.getByRole("radio", { name: runtimeModeConfig["approval-required"].label });
    checked.element().focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect
      .element(page.getByRole("radio", { name: runtimeModeConfig["auto-accept-edits"].label }))
      .toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(checked).toHaveFocus();
    const disabled = page.getByRole("radio", { name: runtimeModeConfig["full-access"].label });
    expect(disabled.element().getAttribute("aria-disabled")).toBe("true");
    // A DOM click: the locator refuses to act on an aria-disabled control.
    (disabled.element() as HTMLElement).click();
    expect(permissionChanges).toEqual([]);
  });
});

it("sizes the options band to its rows", async () => {
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
        effortPanel={<div style={{ height: 36 }}>One row</div>}
        onInstanceModelChange={() => {}}
      />
    </TooltipProvider>,
    { router: false },
  );
  await page.getByRole("button", { name: /Opus 5\.5/ }).click();
  await expect.poll(() => document.querySelector("[data-model-picker-effort]") !== null).toBe(true);
  const panel = document.querySelector<HTMLElement>("[data-model-picker-effort]")!;
  // The rows plus the rule above them; the old 88px floor would leave an empty band.
  expect(panel.getBoundingClientRect().height).toBeLessThanOrEqual(38);
});

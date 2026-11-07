import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@houston-app/contracts";
import { compileResolvedKeybindingsConfig } from "@houston-app/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ComposerEffortPanel, ComposerPickerFooter } from "../ui/composer-model-effort";
import { runtimeModeConfig, runtimeModeOptions } from "./runtimeModeConfig";
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

it("names the model in the trigger exactly as its row in the list does", async () => {
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
  await expect.element(page.getByRole("option", { name: /Claude Opus 5\.5/ })).toBeVisible();
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
  // One model: one row of the list plus the search and provider rows, well under eight rows.
  await expect
    .poll(() => content()?.getBoundingClientRect().height ?? 0)
    .toBeLessThan(8 * 34 + 120);
  await expect.poll(() => content()?.getBoundingClientRect().height ?? 0).toBeGreaterThan(100);
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

  await page.getByRole("option", { name: /Claude Sonnet 5\.5/ }).click();

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

  it("is one 300px list over the effort panel, not a three-pane popover", async () => {
    await using _screen = await openDocked();

    const frame = () =>
      document.querySelector<HTMLElement>('[data-model-picker-content="true"]')!.parentElement!;
    await expect.poll(() => Math.round(frame().getBoundingClientRect().width)).toBe(300);
    const list = rect('[data-model-picker-content="true"]');
    const panel = rect("[data-model-picker-effort]");
    expect(panel.top).toBeGreaterThanOrEqual(list.bottom - 1);
    // Both fill the frame inside its 1px border.
    expect(Math.round(list.width)).toBe(298);
    expect(Math.round(panel.width)).toBe(298);
    expect(rect('[data-slot="popover-positioner"]').height).toBeLessThan(320);
  });

  it("puts the providers in one horizontal row under the search field", async () => {
    await using _screen = await openDocked();

    const sidebar = rect("[data-model-picker-sidebar]");
    expect(Math.round(sidebar.height)).toBeLessThan(48);
    expect(Math.round(sidebar.width)).toBeGreaterThan(200);
    // The segments share one row.
    const favorites = page.getByRole("button", { name: "Favorites" }).element();
    const claude = page.getByRole("button", { name: "Claude" }).element();
    expect(Math.round(favorites.getBoundingClientRect().top)).toBe(
      Math.round(claude.getBoundingClientRect().top),
    );
    // And they sit below the search field.
    const search = document.querySelector<HTMLInputElement>("[data-model-picker-content] input")!;
    expect(sidebar.top).toBeGreaterThanOrEqual(search.getBoundingClientRect().bottom);
  });

  it("shows no footer unless the composer supplies one", async () => {
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

describe("new-thread page placement", () => {
  async function openInHero(paddingTop: number) {
    await page.viewport(1440, 900);
    const screen = await render(
      <TooltipProvider delay={0}>
        <div data-chat-column="">
          <div data-draft-hero="" style={{ paddingTop, paddingLeft: 160 }}>
            <form data-chat-composer-form="true" style={{ width: 760 }}>
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

  it.each([120, 400, 640])(
    "opens under the trigger with %ipx above the composer, however little room is below",
    async (paddingTop) => {
      await using _screen = await openInHero(paddingTop);
      const trigger = page.getByRole("button", { name: /Opus 5\.5/ }).element();
      const popup = document.querySelector<HTMLElement>('[data-slot="popover-positioner"]')!;
      await expect
        .poll(() => popup.getBoundingClientRect().top)
        .toBeGreaterThanOrEqual(trigger.getBoundingClientRect().bottom);
    },
  );
});

describe("new-thread picker with its footer", () => {
  const manyModels = provider.models.concat(
    ["Sonnet 5.5", "Haiku 5.5", "Opus 5", "Sonnet 5", "Haiku 5", "Opus 4.5"].map((name, index) => ({
      slug: `extra-${index}`,
      name: `Claude ${name}`,
      isCustom: false,
      capabilities: { optionDescriptors: [effort] },
    })),
  );
  const modeOptions = runtimeModeOptions.map((mode) => ({ mode, ...runtimeModeConfig[mode] }));

  async function openInDraftHero() {
    await page.viewport(1440, 900);
    const screen = await render(
      <TooltipProvider delay={0}>
        <div data-chat-column="" style={{ height: 900 }}>
          <div data-draft-hero="" style={{ paddingTop: 560, paddingLeft: 160 }}>
            <form data-chat-composer-form="true" style={{ width: 760 }}>
              <div
                data-inline-resting-controls="true"
                style={{ padding: "12px 32px" }}
                className="rounded-xl border border-border"
              >
                <div data-testid="composer-editor" style={{ height: 40 }} />
                <ProviderModelPicker
                  environmentId={null}
                  activeInstanceId={CLAUDE}
                  model="opus"
                  lockedProvider={null}
                  instanceEntries={entries}
                  keybindings={compileResolvedKeybindingsConfig([])}
                  modelOptionsByInstance={new Map([[CLAUDE, manyModels]])}
                  isComposerOwned
                  effortPanel={<ComposerEffortPanel traits={null} />}
                  footer={
                    <ComposerPickerFooter
                      runtimeMode="full-access"
                      runtimeModeOptions={modeOptions}
                      onRuntimeModeChange={() => {}}
                    />
                  }
                  onInstanceModelChange={() => {}}
                />
              </div>
            </form>
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

  it("keeps four model rows visible under a low composer, without reaching its input", async () => {
    await using _screen = await openInDraftHero();
    const list = document.querySelector<HTMLElement>("[data-model-picker-list]")!;
    const frame = document.querySelector<HTMLElement>("[data-docked-picker-frame]")!;
    const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
    await expect.poll(() => Math.round(list.getBoundingClientRect().height)).toBeGreaterThan(0);
    await expect
      .poll(() => {
        const listBox = list.getBoundingClientRect();
        const frameBox = frame.getBoundingClientRect();
        const visibleRows = [...list.querySelectorAll<HTMLElement>('[role="option"]')].filter(
          (row) => {
            const box = row.getBoundingClientRect();
            return box.height > 0 && box.top >= listBox.top - 1 && box.bottom <= frameBox.bottom;
          },
        );
        return visibleRows.length;
      })
      .toBeGreaterThanOrEqual(4);
    expect(frame.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      editor.getBoundingClientRect().bottom - 1,
    );
    expect(frame.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
  });

  it("shows a current model and its Legacy models row whole, above the effort panel, under the capture's composer", async () => {
    // The new-thread page at 1440x900: the composer card ends at y=626, a 36px toolbar under its input.
    const legacyModels = [
      provider.models[0]!,
      ...["Legacy A", "Legacy B"].map((name, index) => ({
        slug: `legacy-${index}`,
        name,
        isCustom: false,
        isLegacy: true,
        capabilities: { optionDescriptors: [effort] },
      })),
    ];
    await page.viewport(1440, 900);
    await using _screen = await render(
      <TooltipProvider delay={0}>
        <div data-chat-column="" style={{ height: 900 }}>
          <div data-draft-hero="" style={{ paddingTop: 534, paddingLeft: 480 }}>
            <form data-chat-composer-form="true" style={{ width: 760 }}>
              <div
                data-inline-resting-controls="true"
                style={{ padding: "12px 16px", height: 92 }}
                className="rounded-xl border border-border"
              >
                <div data-testid="composer-editor" style={{ height: 40 }} />
                <ProviderModelPicker
                  environmentId={null}
                  activeInstanceId={CLAUDE}
                  model="opus"
                  lockedProvider={null}
                  instanceEntries={entries}
                  keybindings={compileResolvedKeybindingsConfig([])}
                  modelOptionsByInstance={new Map([[CLAUDE, legacyModels as never]])}
                  isComposerOwned
                  effortPanel={<ComposerEffortPanel traits={null} />}
                  footer={
                    <ComposerPickerFooter
                      runtimeMode="full-access"
                      runtimeModeOptions={modeOptions}
                      onRuntimeModeChange={() => {}}
                    />
                  }
                  onInstanceModelChange={() => {}}
                />
              </div>
            </form>
          </div>
        </div>
      </TooltipProvider>,
      { router: false },
    );
    await page.getByRole("button", { name: /Opus 5\.5/ }).click();
    const legacyRow = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-model-picker-legacy-section]");
      expect(found).not.toBeNull();
      return found!;
    });
    const list = document.querySelector<HTMLElement>("[data-model-picker-list]")!;
    const effortPanel = document.querySelector<HTMLElement>("[data-model-picker-effort]")!;
    const frame = document.querySelector<HTMLElement>("[data-docked-picker-frame]")!;
    const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
    // The popup is still moving into place: compare the boxes at one instant, until they settle.
    await expect
      .poll(() => legacyRow.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom)
      .toBeLessThanOrEqual(1);
    await expect
      .poll(
        () => legacyRow.getBoundingClientRect().bottom - effortPanel.getBoundingClientRect().top,
      )
      .toBeLessThanOrEqual(1);
    expect(frame.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      editor.getBoundingClientRect().bottom - 1,
    );
    expect(frame.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    // Nothing in the frame is cut: its content is as tall as the frame.
    expect(frame.scrollHeight).toBeLessThanOrEqual(frame.clientHeight + 1);
  });

  it("opens Permissions beside the picker with every description whole", async () => {
    await using _screen = await openInDraftHero();
    await page.getByRole("button", { name: /Permissions: Full access/ }).click();
    const submenu = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-composer-permissions]");
      expect(found).not.toBeNull();
      return found!;
    });
    const frame = document.querySelector<HTMLElement>("[data-docked-picker-frame]")!;
    const search = document.querySelector<HTMLElement>("[data-model-picker-content] input")!;
    const box = submenu.closest<HTMLElement>('[data-slot="menu-popup"]')!.getBoundingClientRect();
    const picker = frame.getBoundingClientRect();
    expect(box.left >= picker.right || box.right <= picker.left).toBe(true);
    expect(box.width).toBeGreaterThanOrEqual(300);
    const searchBox = search.getBoundingClientRect();
    expect(box.left >= searchBox.right || box.right <= searchBox.left).toBe(true);
    for (const description of submenu.querySelectorAll<HTMLElement>("[id*='-']")) {
      expect(description.scrollWidth).toBeLessThanOrEqual(description.clientWidth);
    }
  });
});

describe("provider tabs", () => {
  const crowded: ServerProvider[] = [
    provider,
    ...["Fixture Agent", "Review Agent", "Planning Agent", "Release Agent"].map((name, index) => ({
      ...provider,
      instanceId: ProviderInstanceId.make(`crowded-${index}`),
      displayName: name,
    })),
  ];

  async function openCrowded() {
    await page.viewport(1440, 900);
    const crowdedEntries = deriveProviderInstanceEntries(crowded);
    const screen = await render(
      <TooltipProvider delay={0}>
        <div style={{ paddingTop: 480, paddingLeft: 160 }}>
          <div data-inline-resting-controls="true" style={{ width: 640, padding: "12px 32px" }}>
            <ProviderModelPicker
              environmentId={null}
              activeInstanceId={CLAUDE}
              model="opus"
              lockedProvider={null}
              instanceEntries={crowdedEntries}
              keybindings={compileResolvedKeybindingsConfig([])}
              modelOptionsByInstance={
                new Map(crowdedEntries.map((entry) => [entry.instanceId, provider.models]))
              }
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
    await expect
      .poll(() => document.querySelector("[data-model-picker-sidebar]") !== null)
      .toBe(true);
    return screen;
  }

  it("scrolls when the strip is narrower than its tabs and fades the edge that hides one", async () => {
    await using _screen = await openCrowded();
    const strip = document.querySelector<HTMLElement>("[data-model-picker-sidebar]")!;

    expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
    await expect.poll(() => strip.dataset.scrollFadeEnd).toBe("true");
    expect(strip.dataset.scrollFadeStart).toBeUndefined();
    expect(getComputedStyle(strip).maskImage).toContain("linear-gradient");

    strip.scrollLeft = strip.scrollWidth;
    await expect.poll(() => strip.dataset.scrollFadeStart).toBe("true");
    expect(strip.dataset.scrollFadeEnd).toBeUndefined();
  });

  it("keeps every tab reachable by name", async () => {
    await using _screen = await openCrowded();
    for (const name of ["Fixture Agent", "Release Agent"]) {
      await expect.element(page.getByRole("button", { name })).toBeInTheDocument();
    }
  });
});

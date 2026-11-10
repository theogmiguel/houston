import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@houston-app/contracts";
import { compileResolvedKeybindingsConfig } from "@houston-app/shared/keybindings";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

const mocks = vi.hoisted(() => ({
  refreshProviders: vi.fn(async (_value: unknown) => undefined),
  modelCatalogRefresh: true,
}));

vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => mocks.refreshProviders) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: (() =>
        Atom.make({
          environment: { capabilities: { modelCatalogRefresh: mocks.modelCatalogRefresh } },
        })) as never,
    },
  };
});

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { TooltipProvider } from "../ui/tooltip";
import { ProviderModelPicker } from "./ProviderModelPicker";

const CLAUDE = ProviderInstanceId.make("claude");
const provider: ServerProvider = {
  instanceId: CLAUDE,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-30T00:00:00.000Z",
  models: [{ slug: "opus", name: "Claude Opus 5.5", isCustom: false, capabilities: {} }],
  skills: [],
  slashCommands: [],
};
const environmentId = EnvironmentId.make("local");

const renderPicker = () =>
  render(
    <TooltipProvider delay={0}>
      <ProviderModelPicker
        environmentId={environmentId}
        activeInstanceId={CLAUDE}
        model="opus"
        lockedProvider={null}
        instanceEntries={deriveProviderInstanceEntries([provider])}
        keybindings={compileResolvedKeybindingsConfig([])}
        modelOptionsByInstance={new Map([[CLAUDE, provider.models]])}
        isComposerOwned
        onInstanceModelChange={() => {}}
      />
    </TooltipProvider>,
    { router: false },
  );

describe("ProviderModelPicker model catalog refresh", () => {
  beforeEach(() => {
    mocks.refreshProviders.mockClear();
    mocks.modelCatalogRefresh = true;
  });

  it("asks the server for new models each time the picker opens", async () => {
    await using _screen = await renderPicker();
    expect(mocks.refreshProviders).not.toHaveBeenCalled();

    await page.getByRole("button", { name: /Opus 5\.5/ }).click();
    await vi.waitFor(() => expect(mocks.refreshProviders).toHaveBeenCalledTimes(1));
    expect(mocks.refreshProviders).toHaveBeenCalledWith({
      environmentId,
      input: { modelCatalogOnly: true },
    });
  });

  it("sends nothing to a server that would probe every provider for it", async () => {
    mocks.modelCatalogRefresh = false;
    await using _screen = await renderPicker();

    await page.getByRole("button", { name: /Opus 5\.5/ }).click();
    await expect.element(page.getByRole("combobox").first()).toBeVisible();
    expect(mocks.refreshProviders).not.toHaveBeenCalled();
  });
});

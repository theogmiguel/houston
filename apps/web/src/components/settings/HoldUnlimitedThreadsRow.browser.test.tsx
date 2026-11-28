import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  holdUnlimitedThreads: false,
  updates: [] as unknown[],
}));

vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePrimaryEnvironmentId: (() => null) as never,
  usePrimaryEnvironment: (() => null) as never,
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: (() => true) as never,
  useEnvironmentsWithScope: (() => new Set<string>()) as never,
}));
vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useServerConfigs: (() => new Map()) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePrimarySettingsAvailable: (() => true) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOptionalSettingsScope: (() => null) as never,
}));
vi.mock(import("./useScopedSettings"), async (importOriginal) => ({
  ...(await importOriginal()),
  useScopedSettings: (() => ({ holdUnlimitedThreads: state.holdUnlimitedThreads })) as never,
  useUpdateScopedSettings: (() => (patch: unknown) => {
    state.updates.push(patch);
  }) as never,
  useScopedSettingsMixed: (() => false) as never,
  useClearScopedSettings: (() => () => {}) as never,
  useClearProjectOverrides: (() => () => {}) as never,
}));

import "~/index.css";
import { render } from "../../../test/render";
import { HoldUnlimitedThreadsRow } from "./SettingsPanels";

describe("HoldUnlimitedThreadsRow", () => {
  it("offers a reset only when the row differs from its default", async () => {
    await page.viewport(1100, 300);
    state.holdUnlimitedThreads = false;
    state.updates = [];
    await using off = await render(<HoldUnlimitedThreadsRow />);
    expect(
      off.container.querySelector(
        'button[aria-label="Reset hold threads that have not hit the limit to default"]',
      ),
    ).toBeNull();

    state.holdUnlimitedThreads = true;
    state.updates = [];
    await using on = await render(<HoldUnlimitedThreadsRow />);
    await on
      .getByRole("button", {
        name: "Reset hold threads that have not hit the limit to default",
      })
      .click();
    expect(state.updates).toEqual([{ holdUnlimitedThreads: false }]);
  });
});

import { DEFAULT_SERVER_SETTINGS } from "@houston-app/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  update: vi.fn(),
  mixed: false,
}));

vi.mock(import("../../i18n/useT"), () => ({
  useT: () => (source: string, params?: Record<string, string | number>) =>
    source.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
      params !== undefined && Object.hasOwn(params, name) ? String(params[name]) : placeholder,
    ),
}));

vi.mock(import("../settings/SettingsScopeContext"), () => ({
  useSettingsScope: (() => ({
    connectedEnvironments: [
      {
        environmentId: "env-a",
        label: "env-a",
        serverConfig: {
          settings: state.settings,
          environment: {
            capabilities: { usageHistoryRetention: true },
          },
        },
      },
    ],
    targets: [{ environmentId: "env-a", settings: state.settings }],
  })) as never,
}));

vi.mock(import("../settings/useScopedSettings"), () => ({
  useScopedSettings: (() => state.settings) as never,
  useScopedSettingsMixed: (() => state.mixed) as never,
  useUpdateScopedSettings: (() => state.update) as never,
}));

vi.mock(import("../settings/settingsSearch"), () => ({
  searchableSetting: (id: string) => ({ id, title: "Usage history retention" }),
}));

vi.mock(import("../settings/settingsLayout"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    SettingsSection: (({ title, children }: { title: string; children: ReactNode }) => (
      <section>
        <h2>{title}</h2>
        {children}
      </section>
    )) as never,
    SettingsRow: (({
      title,
      status,
      description,
      resetAction,
      control,
    }: {
      title: ReactNode;
      status?: ReactNode;
      description?: ReactNode;
      resetAction?: ReactNode;
      control?: ReactNode;
    }) => (
      <div>
        <h3>{title}</h3>
        {status === undefined ? null : <div data-testid="retention-status">{status}</div>}
        {description}
        {resetAction}
        {control}
      </div>
    )) as never,
    SettingResetButton: (({ label, onClick }: { label: string; onClick: () => void }) => (
      <button aria-label={`Reset ${label}`} onClick={onClick} />
    )) as never,
  };
});

import { render } from "../../../test/render";
import { UsageRetentionSettings } from "./UsageRetentionSettings";

function setup(usageRetentionDays: number | null) {
  state.settings = { ...DEFAULT_SERVER_SETTINGS, usageRetentionDays };
  state.mixed = false;
  state.update.mockReset();
}

it("keeps the supported maximum by default and confirms before a shorter window purges records", async () => {
  setup(365);
  await using screen = await render(<UsageRetentionSettings />);

  await expect
    .element(screen.getByTestId("retention-status"))
    .toHaveTextContent("Keeping 365 days.");

  const input = screen.getByLabelText("Usage history retention in days").element();
  await userEvent.fill(input, "30");
  await userEvent.type(input, "{Enter}");
  await expect.element(page.getByText("Delete older usage records?")).toBeVisible();
  await expect
    .element(page.getByText(/on the next Usage refresh. This cannot be undone./))
    .toBeVisible();
  expect(state.update).not.toHaveBeenCalled();

  await page.getByText("Delete older records").click();
  expect(state.update).toHaveBeenCalledWith({ usageRetentionDays: 30 });
});

it("shows the effective value and resets a shorter window to the default", async () => {
  setup(30);
  await using screen = await render(<UsageRetentionSettings />);

  await expect
    .element(screen.getByTestId("retention-status"))
    .toHaveTextContent("Keeping 30 days.");
  await screen.getByLabelText("Reset usage history retention").click();
  expect(state.update).toHaveBeenCalledWith({ usageRetentionDays: 365 });
});

it("shows the keep-all choice for the supported maximum", async () => {
  setup(null);
  await using screen = await render(<UsageRetentionSettings />);

  await expect
    .element(screen.getByTestId("retention-status"))
    .toHaveTextContent("Keeping all available history, up to 365 days.");
  await expect
    .element(screen.getByLabelText("Keep all available history"))
    .toHaveAttribute("aria-checked", "true");
});

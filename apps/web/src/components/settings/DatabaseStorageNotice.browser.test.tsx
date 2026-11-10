import { act, render } from "../../../test/render";
import { RegistryProvider } from "@effect/atom-react";
import { EnvironmentId } from "@houston-app/contracts";
import * as Cause from "effect/Cause";
import { type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  reclaim: vi.fn(),
  allowed: true,
  offers: [] as Array<{ environmentId: string; status: { reclaimableBytes: number } }>,
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const offers = Atom.make(() => state.offers);
  const none = Atom.make(() => []);
  const allowed = Atom.make(() => state.allowed);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      databaseCompactionRecommendations: (() => none) as never,
      databaseReclaimOffers: (() => offers) as never,
      reclaimDatabaseSpace: {
        ...actual.serverEnvironment.reclaimDatabaseSpace,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.reclaim) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ title, description, control }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {control}
    </div>
  ),
  SettingsSection: (({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  )) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: vi.fn() } };
});

import { toastManager } from "../ui/toast";
import { DatabaseStorageNotice } from "./DatabaseStorageNotice";

const environmentId = EnvironmentId.make("env-a");
const environments = [
  {
    environmentId,
    label: "This machine",
    serverConfig: { environment: { capabilities: { databaseReclaim: true } } },
  },
];
const panel = (list: typeof environments = environments) => (
  <RegistryProvider>
    <DatabaseStorageNotice environments={list} />
  </RegistryProvider>
);
const reclaimButton = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button")).find((button) =>
    /Reclaim/.test(button.textContent ?? ""),
  );

beforeEach(() => {
  state.reclaim.mockReset();
  state.allowed = true;
  state.offers = [{ environmentId, status: { reclaimableBytes: 200 * 1024 ** 2 } }];
  vi.mocked(toastManager.add).mockClear();
});

it("offers a one-click reclaim with the size it would return", async () => {
  await using screen = await render(panel());

  await expect.element(screen.getByText("200 MB on This machine")).toBeInTheDocument();
  expect(reclaimButton(screen.container)?.disabled).toBe(false);
});

it("offers nothing for a server that cannot reclaim or when nothing is worth returning", async () => {
  {
    await using screen = await render(
      panel([{ environmentId, label: "Old server", serverConfig: null } as never]),
    );
    expect(reclaimButton(screen.container)).toBeUndefined();
  }
  state.offers = [];
  await using empty = await render(panel());
  expect(reclaimButton(empty.container)).toBeUndefined();
});

it("disables the button without the settings grant", async () => {
  state.allowed = false;
  await using screen = await render(panel());

  expect(reclaimButton(screen.container)?.disabled).toBe(true);
});

it("reports a refusal with the server's own message", async () => {
  const message = "Reclaiming needs 128 MiB of free disk space; 10 MiB is free.";
  state.reclaim.mockResolvedValue({ _tag: "Failure", cause: Cause.fail({ message }) });
  await using screen = await render(panel());

  await act(async () => reclaimButton(screen.container)?.click());

  expect(state.reclaim).toHaveBeenCalledWith({ environmentId, input: {} });
  await vi.waitFor(() =>
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Could not reclaim space on This machine",
        description: expect.stringContaining(message),
      }),
    ),
  );
});

it("says what is left when one request hit its time limit", async () => {
  state.reclaim.mockResolvedValue({
    _tag: "Success",
    value: {
      reclaimedBytes: 100 * 1024 ** 2,
      remainingBytes: 50 * 1024 ** 2,
      databaseBytes: 0,
      timeLimitSeconds: 120,
    },
  });
  await using screen = await render(panel());

  await act(async () => reclaimButton(screen.container)?.click());

  await vi.waitFor(() =>
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        description: expect.stringContaining("120 s limit"),
      }),
    ),
  );
});

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type DesktopUpdateState,
  type ServerProvider,
} from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";
import { toastManager } from "../ui/toast";
import { SidebarProvider } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarUpdatesButton } from "./SidebarUpdatesButton";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    update: null as DesktopUpdateState | null,
    providers: [] as ServerProvider[],
    hasUpdates: false,
    providersMarker: { marker: "providers" },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: () => {
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("../../state/desktopUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/desktopUpdate")>()),
  useDesktopUpdateState: (await import("react")).useSyncExternalStore.bind(
    null,
    mocks.subscribe,
    () => mocks.update,
  ),
}));
vi.mock("../../state/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/server")>()),
  primaryServerProvidersAtom: mocks.providersMarker,
}));
vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    useAtomValue: ((atom: unknown, ...rest: unknown[]) =>
      atom === mocks.providersMarker
        ? mocks.providers
        : (actual.useAtomValue as (...args: unknown[]) => unknown)(atom, ...rest)) as never,
  };
});
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isDesktopHost: true,
}));
vi.mock("./useUpdateEverything", () => ({
  useUpdateEverything: () => ({
    hasUpdates: mocks.hasUpdates,
    summary: "Update everything",
    version: null,
    providerCount: 0,
    rows: [],
    restarts: [],
  }),
}));

const checkedAt = "2026-10-19T03:00:00.000Z";

function updateState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    status: "available",
    channel: "latest",
    currentVersion: "0.9.3",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.9.4",
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
    ...overrides,
  };
}

function runningProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "2.1.303",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    updateState: {
      status: "running",
      startedAt: checkedAt,
      finishedAt: null,
      message: "Provider updating.",
      output: null,
    },
  };
}

function terminalProvider(status: "succeeded" | "failed"): ServerProvider {
  const provider = runningProvider();
  return {
    ...provider,
    updateState: {
      status,
      startedAt: checkedAt,
      finishedAt: "2026-10-19T04:00:00.000Z",
      message: status === "failed" ? "Update failed." : "Provider updated.",
      output: null,
    },
  };
}

function setup(update: DesktopUpdateState | null, providers: ServerProvider[] = []) {
  mocks.update = update;
  mocks.providers = providers;
  mocks.hasUpdates = false;
  localStorage.clear();
  return {
    [Symbol.dispose]: () => {
      localStorage.clear();
      vi.restoreAllMocks();
      delete (window as { hostBridge?: unknown }).hostBridge;
    },
  } satisfies Disposable;
}

const renderButton = () =>
  render(
    <TooltipProvider delay={0}>
      <SidebarProvider defaultOpen>
        <ul data-testid="host">
          <SidebarUpdatesButton />
        </ul>
      </SidebarProvider>
    </TooltipProvider>,
  );

const updatesButton = () => document.querySelector<HTMLButtonElement>("[data-sidebar-updates]");

describe("SidebarUpdatesButton", () => {
  it("is absent, and takes no space, when nothing has an update", async () => {
    using _env = setup(null);
    await using screen = await renderButton();
    expect(updatesButton()).toBeNull();
    expect(screen.getByTestId("host").element().childElementCount).toBe(0);
  });

  it("is absent while the app is only checking or has no update to offer", async () => {
    using _env = setup(updateState({ status: "up-to-date", availableVersion: null }));
    await using _screen = await renderButton();
    expect(updatesButton()).toBeNull();
  });

  it.each([
    ["available", updateState(), "Update 0.9.4 ready to download", "available"],
    [
      "downloading",
      updateState({ status: "downloading", downloadPercent: 55 }),
      "Downloading update (55%)",
      "downloading",
    ],
    [
      "downloaded",
      updateState({ status: "downloaded", downloadedVersion: "0.9.4" }),
      "Update ready: restart to install",
      "ready",
    ],
    [
      "failed",
      updateState({ status: "error", errorContext: "download", canRetry: true }),
      "Update failed: couldn't download",
      "failed",
    ],
  ] as const)(
    "states the %s status in words and on the icon",
    async (_name, state, label, tone) => {
      using _env = setup(state);
      await using _screen = await renderButton();
      const button = updatesButton()!;
      expect(button.getAttribute("aria-label")).toBe(label);
      expect(button.getAttribute("data-update-status")).toBe(tone);
      expect(button.getBoundingClientRect().width).toBe(28);
      await userEvent.hover(button);
      await vi.waitFor(() =>
        expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(label),
      );
    },
  );

  it("is one icon when the app and the agents both have something to show", async () => {
    using _env = setup(updateState(), [runningProvider()]);
    await using _screen = await renderButton();
    expect(document.querySelectorAll("[data-sidebar-updates]")).toHaveLength(1);
    const label = updatesButton()!.getAttribute("aria-label")!;
    expect(label).toContain("Update 0.9.4 ready to download");
    expect(label).toContain("Updating Claude");
  });

  it("opens a popover with one row per source and starts nothing by itself", async () => {
    const downloadUpdate = vi.fn(async () => ({ completed: true, state: updateState() }));
    (window as { hostBridge?: unknown }).hostBridge = { downloadUpdate, installUpdate: vi.fn() };
    using _env = setup(updateState(), [runningProvider()]);
    await using _screen = await renderButton();
    await userEvent.click(updatesButton()!);
    await expect.element(page.getByRole("dialog")).toBeVisible();
    const popup = document.querySelector('[role="dialog"]')!;
    expect(popup.textContent).toContain("Update 0.9.4");
    expect(popup.textContent).toContain("Updating Claude");
    expect(downloadUpdate).not.toHaveBeenCalled();

    await userEvent.click(
      page.getByRole("button", { name: "Update 0.9.4 ready to download" }).element(),
    );
    expect(downloadUpdate).toHaveBeenCalledOnce();
  });

  it("opens from the keyboard, and Escape closes it and returns focus to the icon", async () => {
    using _env = setup(updateState());
    await using _screen = await renderButton();
    updatesButton()!.focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(document.activeElement).toBe(updatesButton());
  });

  it("reacts to the update state changing", async () => {
    using _env = setup(null);
    await using _screen = await renderButton();
    expect(updatesButton()).toBeNull();
    await act(() => {
      mocks.update = updateState({ status: "downloaded", downloadedVersion: "0.9.4" });
      mocks.notify();
    });
    expect(updatesButton()?.getAttribute("data-update-status")).toBe("ready");
  });
});

describe("the new-version toast", () => {
  it("shows once per version, across a remount, with an action that opens the popover", async () => {
    const add = vi.spyOn(toastManager, "add");
    using _env = setup(updateState());
    {
      await using _screen = await renderButton();
      await vi.waitFor(() => expect(add).toHaveBeenCalledOnce());
    }
    {
      await using _screen = await renderButton();
      await act(() => Promise.resolve());
    }
    expect(add).toHaveBeenCalledOnce();

    const toast = add.mock.calls[0]![0] as { title?: string; actionProps?: { children?: unknown } };
    expect(String(toast.title)).toContain("0.9.4");
    expect(toast.actionProps?.children).toBeTruthy();

    await using _screen = await renderButton();
    await act(() => {
      mocks.update = updateState({ availableVersion: "0.9.5" });
      mocks.notify();
    });
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(2));
  });

  it("is not shown for an update that is already downloaded or for agent updates", async () => {
    const add = vi.spyOn(toastManager, "add");
    using _env = setup(updateState({ status: "downloaded", downloadedVersion: "0.9.4" }), [
      runningProvider(),
    ]);
    await using _screen = await renderButton();
    await act(() => Promise.resolve());
    expect(add).not.toHaveBeenCalled();
  });
});

describe("the popover rows", () => {
  it("lays out the offered release with its download action and a Later button", async () => {
    using _env = setup(
      updateState({
        currentVersion: "0.9.2",
        releaseNotes: [
          {
            version: "0.9.4",
            items: ["Faster thread switching in layouts of six."],
            totalItems: 1,
            releasedAt: "2026-10-27",
          },
        ],
      }),
    );
    await using _screen = await renderButton();
    await userEvent.click(updatesButton()!);
    const popup = document.querySelector('[role="dialog"]')!;
    await vi.waitFor(() => expect(popup.textContent).toContain("Houston 0.9.4 is available"));
    expect(popup.textContent).toContain("You have 0.9.2");
    expect(popup.textContent).toContain("Faster thread switching in layouts of six.");
    await expect.element(page.getByRole("button", { name: "Download update" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Later" }));
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  });

  it("removes a dismissed agent failure, and the icon with it", async () => {
    using _env = setup(null, [terminalProvider("failed")]);
    await using _screen = await renderButton();
    expect(updatesButton()?.getAttribute("data-update-status")).toBe("failed");
    await userEvent.click(updatesButton()!);
    await userEvent.click(page.getByRole("button", { name: "Dismiss provider update notice" }));
    await vi.waitFor(() => expect(updatesButton()).toBeNull());
  });

  it("drops a finished agent update after it has been shown for a moment", async () => {
    using _env = setup(null, [terminalProvider("succeeded")]);
    using _timers = fakeTimers();
    await using _screen = await renderButton();
    expect(updatesButton()).not.toBeNull();
    await act(() => vi.advanceTimersByTime(3_100));
    expect(updatesButton()).toBeNull();
  });
});

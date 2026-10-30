import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    update: null as DesktopUpdateState | null,
    hasUpdates: false,
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
// The pill only renders in the desktop app.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isElectron: true,
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

function nightlyUpdate(releaseNotes: DesktopUpdateState["releaseNotes"]): DesktopUpdateState {
  return {
    enabled: true,
    status: "available",
    channel: "nightly",
    currentVersion: "0.0.50-nightly.1",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.0.50-nightly.2",
    downloadedVersion: null,
    releaseNotes,
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

function updateState(overrides: Partial<DesktopUpdateState>): DesktopUpdateState {
  return { ...nightlyUpdate([]), ...overrides };
}

const RELEASE_NOTES: DesktopUpdateState["releaseNotes"] = [
  { version: "0.0.50-nightly.2", items: ["Faster sidebar."], totalItems: 1 },
];

function setup(update: DesktopUpdateState | null, { hasUpdates = false } = {}) {
  mocks.update = update;
  mocks.hasUpdates = hasUpdates;
}

function publish(update: DesktopUpdateState | null) {
  return act(() => {
    mocks.update = update;
    mocks.notify();
  });
}

const releaseNotes = () => document.querySelector('[aria-label="Update release notes"]');

describe("SidebarUpdatePill rail row", () => {
  it("offers the available version", async () => {
    setup(updateState({ status: "available", availableVersion: "0.9.4" }));
    await using _screen = await render(<SidebarUpdatePill />);

    const button = page.getByRole("button", { name: "Update 0.9.4 ready to download" });
    await expect.element(button).toHaveTextContent("Update 0.9.4");
  });

  it("shows download progress", async () => {
    setup(
      updateState({
        status: "downloading",
        availableVersion: "0.9.4",
        downloadPercent: 55,
      }),
    );
    await using _screen = await render(<SidebarUpdatePill />);

    const button = page.getByRole("button", { name: "Downloading update (55%)" });
    await expect.element(button).toHaveTextContent("Downloading 55%");
    expect(button.element().getAttribute("aria-disabled")).toBe("true");
  });

  it("asks for a restart once the update is downloaded", async () => {
    setup(
      updateState({
        status: "downloaded",
        availableVersion: "0.9.4",
        downloadedVersion: "0.9.4",
      }),
    );
    await using _screen = await render(<SidebarUpdatePill />);

    await expect
      .element(
        page.getByRole("button", {
          name: "Update 0.9.4 downloaded. Click to restart and install.",
        }),
      )
      .toHaveTextContent("Restart to update");
  });

  it("reports a failed download", async () => {
    setup(
      updateState({
        status: "error",
        availableVersion: "0.9.4",
        errorContext: "download",
        canRetry: true,
      }),
    );
    await using _screen = await render(<SidebarUpdatePill />);

    await expect
      .element(page.getByRole("button", { name: "Download failed for 0.9.4. Click to retry." }))
      .toHaveTextContent("Couldn't download");
  });

  it("stays out of the rail when there is no update", async () => {
    setup(updateState({ status: "up-to-date" }));
    await using screen = await render(<SidebarUpdatePill />);

    expect(screen.container.querySelector("button")).toBeNull();
  });
});

describe("SidebarUpdatePill release notes", () => {
  it("lays out the offered release with its download action", async () => {
    setup(
      updateState({
        status: "available",
        currentVersion: "0.9.2",
        availableVersion: "0.9.4",
        releaseNotes: [
          {
            version: "0.9.4",
            items: ["Faster thread switching in grids of six."],
            totalItems: 1,
            releasedAt: "2026-10-27",
          },
        ],
      }),
    );
    await using _screen = await render(<SidebarUpdatePill />);
    await userEvent.tab();
    await vi.waitFor(() => expect(releaseNotes()).not.toBeNull());

    const notes = releaseNotes()!;
    expect(notes.textContent).toContain("Houston 0.9.4 is available");
    expect(notes.textContent).toContain("You have 0.9.2");
    expect(notes.textContent).toContain("What's new");
    expect(notes.textContent).toContain("Faster thread switching in grids of six.");

    await expect.element(page.getByRole("button", { name: "Download update" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Later" }));
    await vi.waitFor(() => expect(releaseNotes()).toBeNull());
  });

  it("closes when the release notes stop applying", async () => {
    setup(nightlyUpdate(RELEASE_NOTES));
    await using _screen = await render(<SidebarUpdatePill />);
    await userEvent.tab();
    await vi.waitFor(() => expect(releaseNotes()).not.toBeNull());

    await publish(nightlyUpdate([]));
    await vi.waitFor(() => expect(releaseNotes()).toBeNull());
  });

  it("opens when release notes arrive while the trigger has keyboard focus", async () => {
    setup(nightlyUpdate([]));
    await using _screen = await render(<SidebarUpdatePill />);
    await userEvent.tab();
    expect(releaseNotes()).toBeNull();

    await publish(nightlyUpdate(RELEASE_NOTES));
    await vi.waitFor(() => expect(releaseNotes()).not.toBeNull());
  });
});

describe("SidebarUpdatePill update everything", () => {
  it("does not refocus the update button after a pointer cancel", async () => {
    setup(null, { hasUpdates: true });
    await using screen = await render(<SidebarUpdatePill />);
    const button = screen.getByRole("button", { name: "Update everything" });
    await userEvent.click(button);
    const cancel = page.getByRole("button", { name: "Cancel" });
    await expect.element(cancel).toBeVisible();

    await userEvent.click(cancel);
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    expect(document.activeElement).not.toBe(button.element());
  });

  it("returns focus to the update button after Escape", async () => {
    setup(null, { hasUpdates: true });
    await using screen = await render(<SidebarUpdatePill />);
    const button = screen.getByRole("button", { name: "Update everything" });
    await userEvent.click(button);
    await expect.element(page.getByRole("button", { name: "Cancel" })).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.activeElement).toBe(button.element()));
  });
});

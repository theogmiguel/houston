import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

const harness = vi.hoisted(() => ({
  open: vi.fn(),
  scratch: vi.fn(),
  newThread: vi.fn(),
  scratchEnvironment: "local" as string | null,
}));

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () =>
    [
      { environmentId: "local", id: "p1", title: "Alpha", archivedAt: null },
      { environmentId: "local", id: "p2", title: "Beta", archivedAt: null },
    ] as never,
  useVisibleThreadShells: () => [],
}));
vi.mock(import("../hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: () => harness.newThread as never,
}));
vi.mock(import("../hooks/useScratchProject"), async (original) => ({
  ...(await original()),
  useScratchProject: () =>
    ({
      scratchEnvironmentId: () => harness.scratchEnvironment,
      startScratchThread: harness.scratch,
    }) as never,
}));
vi.mock(import("../browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () =>
    ({
      profiles: [
        { id: "work", name: "Work" },
        { id: "home", name: "Home" },
      ],
    }) as never,
}));
vi.mock(import("./useThreadSurfaceOpeners"), () => {
  const kinds = [
    "diff",
    "files",
    "browser",
    "terminal",
    "pull-request",
    "pull-requests",
    "device",
    "side-chat",
  ] as const;
  return {
    useThreadSurfaceOpeners: () => ({
      surfaces: Object.fromEntries(
        kinds.map((kind) => [
          kind,
          kind === "diff"
            ? { available: false, reason: "Not a Git repository." }
            : { available: true, reason: "" },
        ]),
      ),
      open: harness.open,
    }),
  };
});

import { render } from "../../test/render";
import { buildLayout } from "./layoutFixtures";
import { LayoutLauncher } from "./LayoutLauncher";
import { useLayoutStore } from "./layoutStore";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("t1"));
const context = { kind: "server", threadRef } as const;

const rowLabels = (container: Element) =>
  Array.from(container.querySelectorAll("[data-layout-launcher-row]")).map((row) =>
    row.querySelector("span:nth-child(2)")?.textContent?.trim(),
  );

describe("LayoutLauncher", () => {
  it("offers projects, no project, the thread's surfaces, browser profiles and pages", async () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
    await using screen = await render(<LayoutLauncher tabId={null} context={context} />);
    expect(rowLabels(screen.container)).toEqual([
      "Alpha",
      "Beta",
      "No project",
      "Changes",
      "Files",
      "Browser",
      "Terminal",
      "Pull request",
      "Linked pull requests",
      "Device",
      "Side chat",
      "Browser in Work",
      "Browser in Home",
      "Settings",
      "Usage",
      "Pull requests",
    ]);
  });

  it("says why a surface is unavailable and does not open it", async () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
    harness.open.mockClear();
    await using screen = await render(<LayoutLauncher tabId={null} context={context} />);
    const changes = Array.from(
      screen.container.querySelectorAll<HTMLElement>("[data-layout-launcher-row]"),
    ).find((row) => row.textContent?.startsWith("Changes"))!;
    expect(changes.textContent).toContain("Not a Git repository.");
    changes.click();
    expect(harness.open).not.toHaveBeenCalled();
  });

  it("opens the chosen surface of its thread, in a browser profile when one is chosen", async () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
    harness.open.mockClear();
    await using screen = await render(<LayoutLauncher tabId={null} context={context} />);
    const row = (label: string) =>
      Array.from(screen.container.querySelectorAll<HTMLElement>("[data-layout-launcher-row]")).find(
        (candidate) => candidate.textContent?.startsWith(label),
      )!;
    row("Files").click();
    expect(harness.open).toHaveBeenLastCalledWith("files", undefined);
    row("Browser in Home").click();
    expect(harness.open).toHaveBeenLastCalledWith("browser", "home");
  });

  it("starts a thread without a project, or refuses by saying why", async () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
    harness.scratch.mockClear().mockResolvedValue(undefined);
    await using screen = await render(<LayoutLauncher tabId={null} context={null} />);
    const noProject = () =>
      Array.from(screen.container.querySelectorAll<HTMLElement>("[data-layout-launcher-row]")).find(
        (candidate) => candidate.textContent?.startsWith("No project"),
      )!;
    noProject().click();
    expect(harness.scratch).toHaveBeenCalledWith("local");

    harness.scratchEnvironment = null;
    await using disabled = await render(<LayoutLauncher tabId={null} context={null} />);
    const refused = Array.from(
      disabled.container.querySelectorAll<HTMLElement>("[data-layout-launcher-row]"),
    ).find((candidate) => candidate.textContent?.startsWith("No project"))!;
    expect(refused.getAttribute("aria-disabled")).toBe("true");
    expect(refused.textContent).toContain("scratch folder");
  });
});

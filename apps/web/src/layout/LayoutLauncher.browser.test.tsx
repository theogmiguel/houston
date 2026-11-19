import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

const SURFACE_KINDS = [
  "diff",
  "files",
  "browser",
  "terminal",
  "pull-request",
  "pull-requests",
  "device",
  "side-chat",
] as const;

const harness = vi.hoisted(() => ({
  open: vi.fn(),
  scratch: vi.fn(),
  newThread: vi.fn(),
  addProject: vi.fn(),
  scratchEnvironment: "local" as string | null,
  profiles: [
    { id: "work", name: "Work" },
    { id: "home", name: "Home" },
  ] as ReadonlyArray<{ readonly id: string; readonly name: string }>,
  unavailable: new Set<string>(),
}));

const project = (input: {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string | null;
  readonly isScratch?: true;
}) => ({
  environmentId: "local",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  archivedAt: null,
  pinnedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...input,
});

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () =>
    [
      project({
        id: "p1",
        title: "Alpha",
        workspaceRoot: "/work/alpha",
        updatedAt: "2026-02-01T00:00:00.000Z",
      }),
      project({
        id: "p2",
        title: "Beta",
        workspaceRoot: "/work/beta",
        updatedAt: "2026-01-15T00:00:00.000Z",
        pinnedAt: "2026-01-02T00:00:00.000Z",
      }),
      project({
        id: "scratch",
        title: "No project",
        workspaceRoot: "/scratch",
        updatedAt: "2026-01-01T00:00:00.000Z",
        isScratch: true,
      }),
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
      scratchWorkspaceRootFor: (environmentId: string | null) =>
        environmentId === "local" ? "/scratch" : null,
      startScratchThread: harness.scratch,
    }) as never,
}));
vi.mock(import("../browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () => ({ profiles: harness.profiles }) as never,
}));
vi.mock(import("../components/AddProjectDialog"), () => ({
  openAddProjectDialog: harness.addProject,
}));
vi.mock(import("./useThreadSurfaceOpeners"), () => ({
  useThreadSurfaceOpeners: () =>
    ({
      surfaces: Object.fromEntries(
        SURFACE_KINDS.map((kind) => [
          kind,
          harness.unavailable.has(kind)
            ? { available: false, reason: `${kind} is unavailable.` }
            : { available: true, reason: "" },
        ]),
      ),
      open: harness.open,
    }) as never,
}));

import { render } from "../../test/render";
import { buildLayout } from "./layoutFixtures";
import { createLayoutLauncherContent, selectFocusedTab } from "./layoutModel";
import { LayoutLauncher } from "./LayoutLauncher";
import { useLayoutStore } from "./layoutStore";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("t1"));
const context = { kind: "server", threadRef } as const;

const rows = (container: Element) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-layout-launcher-row]"));
const rowLabels = (container: Element) =>
  rows(container).map((row) => row.querySelector("span:nth-child(2)")?.textContent?.trim());
const row = (container: Element, label: string) =>
  rows(container).find(
    (candidate) => candidate.querySelector("span:nth-child(2)")?.textContent?.trim() === label,
  );

const resetHarness = () => {
  harness.open.mockClear();
  harness.scratch.mockClear();
  harness.newThread.mockClear();
  harness.addProject.mockClear();
  harness.scratchEnvironment = "local";
  harness.profiles = [
    { id: "work", name: "Work" },
    { id: "home", name: "Home" },
  ];
  harness.unavailable.clear();
};

describe("LayoutLauncher", () => {
  it("offers projects, no project, add project, the thread's surfaces and pages", async () => {
    resetHarness();
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
    await using screen = await render(<LayoutLauncher tabId={null} context={context} />);
    expect(rowLabels(screen.container)).toEqual([
      "Beta",
      "Alpha",
      "No project",
      "Add project…",
      "Changes",
      "Files",
      "Browser in Work",
      "Browser in Home",
      "Terminal",
      "Pull request",
      "Linked pull requests",
      "Device",
      "Side chat",
      "Pull requests",
      "Issues",
      "Tasks",
    ]);
  });

  it("orders projects the way the project picker does, pinned first", async () => {
    resetHarness();
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
    await using screen = await render(<LayoutLauncher tabId={null} context={null} />);
    expect(rowLabels(screen.container).slice(0, 3)).toEqual(["Beta", "Alpha", "No project"]);
  });

  it("adds a project from the last row of Start a thread in", async () => {
    resetHarness();
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
    await using screen = await render(<LayoutLauncher tabId={null} context={null} />);
    const labels = rowLabels(screen.container);
    const addProject = row(screen.container, "Add project…");
    expect(addProject).toBeDefined();
    expect(labels.indexOf("Add project…")).toBeGreaterThan(labels.indexOf("No project"));
    addProject!.click();
    expect(harness.addProject).toHaveBeenCalledTimes(1);
  });

  it("lists No project once, leaving the scratch project out", async () => {
    resetHarness();
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
    await using screen = await render(<LayoutLauncher tabId={null} context={null} />);
    expect(rowLabels(screen.container).filter((label) => label === "No project")).toHaveLength(1);
  });

  it("draws every row at one height, with or without a shortcut", async () => {
    resetHarness();
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
    await using screen = await render(<LayoutLauncher tabId={null} context={context} />);
    const heights = new Set(
      rows(screen.container).map((row) => Math.round(row.getBoundingClientRect().height)),
    );
    expect([...heights]).toEqual([32]);
  });

  it("shows one Browser row per profile when more than one exists, without the generic row", async () => {
    resetHarness();
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
    await using screen = await render(<LayoutLauncher tabId={null} context={context} />);
    const labels = rowLabels(screen.container);
    expect(labels).not.toContain("Browser");
    expect(labels.filter((label) => label?.startsWith("Browser in "))).toEqual([
      "Browser in Work",
      "Browser in Home",
    ]);
  });

  it("shows just Browser when there is one profile", async () => {
    resetHarness();
    harness.profiles = [{ id: "work", name: "Work" }];
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
    await using screen = await render(<LayoutLauncher tabId={null} context={context} />);
    const labels = rowLabels(screen.container);
    expect(labels).toContain("Browser");
    expect(labels).not.toContain("Browser in Work");
  });

  it("keeps the Pull requests page but hides pull-request surfaces a thread lacks", async () => {
    resetHarness();
    harness.unavailable.add("pull-request");
    harness.unavailable.add("pull-requests");
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
    await using screen = await render(<LayoutLauncher tabId={null} context={context} />);
    const labels = rowLabels(screen.container);
    expect(labels).not.toContain("Pull request");
    expect(labels).not.toContain("Linked pull requests");
    expect(labels).toContain("Pull requests");
  });

  it("hides unavailable surface rows and the heading when none are available", async () => {
    resetHarness();
    for (const kind of SURFACE_KINDS) harness.unavailable.add(kind);
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
    await using screen = await render(<LayoutLauncher tabId={null} context={context} />);
    const labels = rowLabels(screen.container);
    for (const label of ["Changes", "Files", "Terminal", "Device", "Side chat"]) {
      expect(labels).not.toContain(label);
    }
    expect(screen.container.textContent).not.toContain("Open beside this thread");
  });

  it("says what Device opens", async () => {
    resetHarness();
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
    await using screen = await render(<LayoutLauncher tabId={null} context={context} />);
    expect(row(screen.container, "Device")?.textContent).toContain(
      "iOS Simulators and Android emulators.",
    );
  });

  it("opens the chosen surface of its thread, in a browser profile when one is chosen", async () => {
    resetHarness();
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
    await using screen = await render(<LayoutLauncher tabId={null} context={context} />);
    row(screen.container, "Files")!.click();
    expect(harness.open).toHaveBeenLastCalledWith("files", undefined);
    row(screen.container, "Browser in Home")!.click();
    expect(harness.open).toHaveBeenLastCalledWith("browser", "home");
  });

  it("starts a thread without a project, or refuses by saying why", async () => {
    resetHarness();
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
    harness.scratch.mockResolvedValue(undefined);
    await using screen = await render(<LayoutLauncher tabId={null} context={null} />);
    row(screen.container, "No project")!.click();
    expect(harness.scratch).toHaveBeenCalledWith("local");

    harness.scratchEnvironment = null;
    await using disabled = await render(<LayoutLauncher tabId={null} context={null} />);
    const refused = row(disabled.container, "No project")!;
    expect(refused.getAttribute("aria-disabled")).toBe("true");
    expect(refused.textContent).toContain("scratch folder");
  });

  it("focuses the open tab of a page instead of opening a second one", async () => {
    resetHarness();
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a", "b"]]]]));
    useLayoutStore.getState().replaceTabContent("b", { kind: "tasks" });
    useLayoutStore.getState().focusTab("a");
    useLayoutStore.getState().replaceTabContent("a", createLayoutLauncherContent(null));
    await using screen = await render(<LayoutLauncher tabId="a" context={null} />);
    row(screen.container, "Tasks")!.click();
    await vi.waitFor(() => {
      expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe("b");
    });
    const kinds = useLayoutStore
      .getState()
      .layout.workspaces.flatMap((workspace) =>
        workspace.columns.flatMap((column) =>
          column.panes.flatMap((pane) => pane.tabs.map((tab) => tab.content.kind)),
        ),
      );
    expect(kinds).toEqual(["tasks"]);
  });
});

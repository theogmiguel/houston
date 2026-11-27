import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const harness = vi.hoisted(() => ({
  projects: [
    {
      environmentId: "local",
      id: "p1",
      title: "Atlas",
      workspaceRoot: "/work/alpha",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      archivedAt: null,
      pinnedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    },
    {
      environmentId: "local",
      id: "p2",
      title: "Borealis",
      workspaceRoot: "/work/beta",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      archivedAt: null,
      pinnedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-15T00:00:00.000Z",
    },
  ],
  settings: {
    sidebarProjectGroupingMode: "none",
    sidebarProjectGroupingOverrides: {},
    sidebarProjectSortOrder: "lastActivity",
  },
  openScratch: vi.fn(),
  addProject: vi.fn(),
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: () => null,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => harness.projects as never,
  useVisibleThreadShells: () => [],
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: () =>
    ({
      environments: [
        {
          environmentId: "local",
          label: "This machine",
          serverConfig: {
            environment: { platform: { machine: "local" } },
            settings: {},
          },
        },
      ],
    }) as never,
  usePrimaryEnvironmentId: () => "local" as never,
  useEnvironmentProviders: () => new Map(),
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector: (settings: typeof harness.settings) => unknown) =>
    selector(harness.settings)) as never,
}));
vi.mock(import("~/hooks/useScratchProject"), async (original) => ({
  ...(await original()),
  useScratchProject: () =>
    ({
      scratchEnvironmentId: () => "local",
      scratchWorkspaceRootFor: (environmentId: string | null) =>
        environmentId === "local" ? "/scratch" : null,
      openScratchProject: harness.openScratch,
    }) as never,
}));
vi.mock(import("~/hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: () => vi.fn() as never,
}));
vi.mock(import("~/hooks/useProjectGroupUpdate"), async (original) => ({
  ...(await original()),
  useProjectPin: () =>
    ({
      canPinProjectGroup: () => false,
      toggleProjectGroupPin: () => {},
    }) as never,
}));
vi.mock(import("~/keybindings"), async (original) => ({
  ...(await original()),
  shortcutLabelForCommand: () => null,
}));
vi.mock(import("~/connection/desktopLocal"), async (original) => ({
  ...(await original()),
  createWslEnvironmentPredicate: () => () => false,
}));
vi.mock(import("../AddProjectDialog"), () => ({
  openAddProjectDialog: harness.addProject,
}));
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { DraftHeroHeadline } from "./DraftHeroHeadline";

async function hero() {
  return render(
    <TooltipProvider>
      <DraftHeroHeadline
        draftId={null}
        activeProjectRef={{ environmentId: "local", projectId: "p1" } as never}
        activeProjectTitle="Atlas"
      />
    </TooltipProvider>,
  );
}

describe("DraftHeroHeadline project picker", () => {
  it("marks the project trigger as a picker with a chevron and a dotted underline", async () => {
    await using screen = await hero();

    const trigger = screen.container.querySelector<HTMLElement>("[data-draft-project-trigger]");
    expect(trigger).not.toBeNull();
    expect(trigger?.querySelector("svg")).not.toBeNull();
    expect(getComputedStyle(trigger!).borderBottomStyle).toBe("dotted");
  });

  it("offers No project inside the picker and drops the old link", async () => {
    await using screen = await hero();

    expect(screen.getByText("or start without a project").elements()).toHaveLength(0);

    const trigger = screen.container.querySelector<HTMLElement>("[data-draft-project-trigger]");
    await userEvent.click(trigger!);

    await expect.element(page.getByRole("option", { name: /No project/ })).toBeInTheDocument();
  });

  it("opens the scratch project when No project is chosen", async () => {
    await using screen = await hero();

    const trigger = screen.container.querySelector<HTMLElement>("[data-draft-project-trigger]");
    await userEvent.click(trigger!);
    await userEvent.click(page.getByRole("option", { name: /No project/ }));

    await vi.waitFor(() => expect(harness.openScratch).toHaveBeenCalledWith("local"));
  });
});

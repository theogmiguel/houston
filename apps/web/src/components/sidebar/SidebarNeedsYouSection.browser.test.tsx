import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { ThreadId } from "@houston-app/contracts";

import { render } from "../../../test/render";
import { clearThreadSelection } from "../../threads/sidebarModel";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarNeedsYouSection } from "./ThreadSidebar";
import { buildNeedsYouEntries } from "./needsYouSection";

type SidebarNeedsYouSectionProps = ComponentProps<typeof SidebarNeedsYouSection>;

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => "env-1") as never,
  useEnvironmentMachines: (() => new Map()) as never,
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  readEnvironmentServerConfigLoaded: () => true,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
}));

function thread(
  id: string,
  projectId: string,
  overrides: Record<string, unknown> = {},
): EnvironmentThreadShell {
  return {
    id,
    environmentId: "env-1",
    projectId,
    title: id,
    branch: "main",
    pullRequests: [],
    branchPullRequest: null,
    providerInstanceId: "claude",
    snoozedUntil: null,
    settledOverride: null,
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestUserMessageAt: null,
    latestRun: null,
    runtime: null,
    autoSettleDisabledAt: null,
    lastVisitedAt: null,
    unsettledAt: null,
    lineage: {
      relationshipToParent: null,
      parentThreadId: null,
      rootThreadId: ThreadId.make(id),
      sideChat: false,
    },
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

const now = "2026-01-04T00:00:00.000Z";
const projectTitles = new Map([
  ["env-1:project-1", "Houston"],
  ["env-1:project-2", "notes"],
]);

function entries() {
  return buildNeedsYouEntries({
    nowIso: now,
    projectKeys: new Set(["env-1:project-1", "env-1:project-2"]),
    threads: [
      thread("fix-it", "project-1", { hasPendingUserInput: true }),
      thread("broken", "project-2", {
        latestRun: { status: "failed", completedAt: "2026-01-02T00:00:00.000Z" },
      }),
    ],
  });
}

function props(overrides: Partial<SidebarNeedsYouSectionProps> = {}): SidebarNeedsYouSectionProps {
  return {
    entries: entries(),
    providerEntriesByEnvironment: new Map(),
    nowIso: now,
    selection: clearThreadSelection(),
    runningSubagents: new Map(),
    dragging: null,
    projectTitleOf: (value) => projectTitles.get(`${value.environmentId}:${value.projectId}`) ?? "",
    onOpenThread: () => {},
    onSelectThread: () => {},
    onCloseThread: () => {},
    onHoldThread: () => {},
    onPickHoldTime: async () => null,
    onRenameThread: () => {},
    onSetAutoClose: () => {},
    ...overrides,
  };
}

describe("SidebarNeedsYouSection", () => {
  it("lists the waiting threads in attention order with their project on the first line", async () => {
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarNeedsYouSection {...props()} />
      </TooltipProvider>,
    );

    const section = screen.container.querySelector<HTMLElement>("[data-needs-you-section]")!;
    expect(section.getAttribute("aria-label")).toBe("Needs you");
    expect(section.querySelector("[data-needs-you-heading]")?.textContent).toContain("Needs you");
    expect(section.querySelector("[data-needs-you-heading]")?.textContent).toContain("2");

    const rows = [...section.querySelectorAll<HTMLElement>("[data-sidebar-row]")];
    expect(rows.map((row) => row.dataset.sidebarRow)).toEqual(["env-1:fix-it", "env-1:broken"]);
    expect(
      rows.map((row) => row.querySelector<HTMLElement>("[data-thread-project]")?.textContent),
    ).toEqual(["Houston", "notes"]);
  });

  it("opens the thread from its row", async () => {
    const onOpenThread = vi.fn();
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarNeedsYouSection {...props({ onOpenThread })} />
      </TooltipProvider>,
    );

    const row = screen.container.querySelector<HTMLElement>('[data-sidebar-row="env-1:fix-it"]')!;
    await userEvent.click(row);
    expect(onOpenThread).toHaveBeenCalledWith(expect.objectContaining({ id: "fix-it" }));
  });

  it("renders nothing when no thread needs the user", async () => {
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarNeedsYouSection {...props({ entries: [] })} />
      </TooltipProvider>,
    );
    expect(screen.container.querySelector("[data-needs-you-section]")).toBeNull();
    expect(screen.container.textContent).toBe("");
  });
});

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
import type { NeedsYouAnswerView } from "../ui/needs-you-answer-model";
import { buildNeedsYouEntries } from "./needsYouSection";

type SidebarNeedsYouSectionProps = ComponentProps<typeof SidebarNeedsYouSection>;

const answerMock = vi.hoisted(() => ({
  build: null as
    | null
    | ((entry: { thread: { id: string; title: string } }) => NeedsYouAnswerView | null),
}));

vi.mock(import("./needsYouAnswer"), () => ({
  useNeedsYouAnswer: (entry: { thread: { id: string; title: string } }) =>
    answerMock.build?.(entry) ?? null,
}));

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

answerMock.build = (entry) => answerViewFor(entry);

function answerViewFor(entry: { thread: { id: string; title: string } }): NeedsYouAnswerView {
  return {
    kind: "input",
    requestId: `request-${entry.thread.id}`,
    question: {
      id: `question-${entry.thread.id}`,
      text: `Question for ${entry.thread.title}`,
      header: "Question",
      options: [{ label: "Keep", value: "keep" }],
      multiSelect: false,
      allowCustomAnswer: true,
    },
    progress: { index: 0, total: 1 },
    selectedValues: [],
    pending: false,
    error: null,
    onToggleOption: () => {},
    onSubmit: () => {},
    onReply: () => {},
  };
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

  it("reveals the answer block from the row and opens the thread from its title", async () => {
    const onOpenThread = vi.fn();
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarNeedsYouSection {...props({ onOpenThread })} />
      </TooltipProvider>,
    );

    const row = screen.container.querySelector<HTMLElement>('[data-sidebar-row="env-1:fix-it"]')!;
    const rowBody = row.querySelector<HTMLElement>("[data-thread-project]")!;
    await userEvent.click(rowBody);
    await expect.element(screen.getByText("Question for fix-it")).toBeVisible();
    expect(onOpenThread).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "fix-it" }));
    expect(onOpenThread).toHaveBeenCalledWith(expect.objectContaining({ id: "fix-it" }));

    await userEvent.click(rowBody);
    expect(screen.container.textContent).not.toContain("Question for fix-it");
  });

  it("keeps opening a Back row's thread from the row", async () => {
    const onOpenThread = vi.fn();
    const backEntries = buildNeedsYouEntries({
      nowIso: now,
      projectKeys: new Set(["env-1:project-1"]),
      threads: [
        thread("back", "project-1", {
          unsettledAt: "2026-01-03T00:00:00.000Z",
          lastVisitedAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarNeedsYouSection {...props({ entries: backEntries, onOpenThread })} />
      </TooltipProvider>,
    );

    const row = screen.container.querySelector<HTMLElement>('[data-sidebar-row="env-1:back"]')!;
    await userEvent.click(row.querySelector<HTMLElement>("[data-thread-project]")!);
    expect(onOpenThread).toHaveBeenCalledWith(expect.objectContaining({ id: "back" }));
  });

  it("keeps one answer block open at a time", async () => {
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarNeedsYouSection {...props()} />
      </TooltipProvider>,
    );

    const first = screen.container.querySelector<HTMLElement>('[data-sidebar-row="env-1:fix-it"]')!;
    const second = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="env-1:broken"]',
    )!;
    await userEvent.click(first.querySelector<HTMLElement>("[data-thread-project]")!);
    await expect.element(screen.getByText("Question for fix-it")).toBeVisible();
    await userEvent.click(second.querySelector<HTMLElement>("[data-thread-project]")!);
    await expect.element(screen.getByText("Question for broken")).toBeVisible();
    expect(screen.container.textContent).not.toContain("Question for fix-it");
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

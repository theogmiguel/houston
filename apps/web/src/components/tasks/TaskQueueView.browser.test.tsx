import type { HoustonTaskSummary } from "@houston-app/contracts/houston/tasks";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { TaskQueueView } from "./TaskQueueView";
import { queueTaskGroups } from "./tasks.logic";

function task(
  overrides: Partial<HoustonTaskSummary> &
    Pick<HoustonTaskSummary, "id" | "number" | "key" | "title">,
): HoustonTaskSummary {
  return {
    projectId: null,
    status: "backlog",
    priority: "none",
    parentId: null,
    refUrl: null,
    revision: 1,
    createdBy: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    acceptanceChecked: 0,
    acceptanceTotal: 0,
    domainKind: null,
    queue: "none",
    ready: false,
    openRun: null,
    ...overrides,
  };
}

const tasks = [
  task({
    id: 1,
    number: 45,
    key: "HOU-45",
    title: "Rename Harness review to Harness",
    status: "in_progress",
    queue: "your_turn",
    openRun: {
      id: 10,
      taskId: 1,
      attempt: 1,
      kind: "implementation",
      state: "waiting_for_input",
      provider: "claude",
      reviewer: null,
      threadId: null,
      runId: null,
      worktreePath: null,
      branch: null,
      baseCommit: null,
      initialRevision: 1,
      summary: null,
      reason: "Keep the old name in the palette as an alias?",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      prUrl: null,
      review: null,
    },
  }),
  task({
    id: 2,
    number: 43,
    key: "HOU-43",
    title: "Dirty marker next to the branch",
    status: "in_review",
    queue: "your_turn",
    acceptanceChecked: 3,
    acceptanceTotal: 3,
  }),
  task({
    id: 3,
    number: 47,
    key: "HOU-47",
    title: "Agents re-read the styleguide",
    status: "todo",
    queue: "up_next",
    priority: "high",
    ready: true,
  }),
  task({
    id: 4,
    number: 53,
    key: "HOU-53",
    title: "Cache usage totals per day",
    status: "backlog",
    queue: "none",
    projectId: "p1" as never,
    domainKind: "delivery",
    acceptanceTotal: 2,
  }),
  task({ id: 5, number: 40, key: "HOU-40", title: "Done work", status: "done" }),
];

it("shows queue sections, rows and the folded done count", async () => {
  await using screen = await render(
    <TaskQueueView groups={queueTaskGroups(tasks)} onOpen={() => {}} onAction={() => {}} />,
  );

  expect(screen.container.textContent).toContain("Your turn");
  expect(screen.container.textContent).toContain("Up next");
  expect(screen.container.textContent).toContain("Backlog");
  expect(screen.container.textContent).toContain("HOU-45");
  expect(screen.container.textContent).toContain("Keep the old name in the palette as an alias?");
  expect(screen.container.textContent).toContain("3/3");
  expect(screen.container.textContent).toContain("Done and archived 1");
  expect(screen.container.textContent).not.toContain("HOU-40");

  await screen.getByRole("button", { name: /Done and archived/ }).click();
  expect(screen.container.textContent).toContain("HOU-40");
});

it("offers the next step per row and reports the row that took it", async () => {
  const onAction = vi.fn();
  const onOpen = vi.fn();
  await using screen = await render(
    <TaskQueueView groups={queueTaskGroups(tasks)} onOpen={onOpen} onAction={onAction} />,
  );

  await screen.getByRole("button", { name: "Answer" }).click();
  expect(onAction).toHaveBeenCalledWith("answer", expect.objectContaining({ key: "HOU-45" }));

  await screen.getByRole("button", { name: "Start" }).click();
  expect(onAction).toHaveBeenCalledWith("start", expect.objectContaining({ key: "HOU-47" }));

  await screen.getByRole("button", { name: "Plan" }).click();
  expect(onAction).toHaveBeenCalledWith("plan", expect.objectContaining({ key: "HOU-53" }));

  await screen.getByRole("button", { name: "HOU-43 Dirty marker next to the branch" }).click();
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: "HOU-43" }));
});

it("filters the list by a search query", async () => {
  await using screen = await render(
    <TaskQueueView
      groups={queueTaskGroups(tasks, { query: "usage" })}
      onOpen={() => {}}
      onAction={() => {}}
    />,
  );
  expect(screen.container.textContent).toContain("HOU-53");
  expect(screen.container.textContent).not.toContain("HOU-45");
});

it("disables Plan on a backlog row that cannot be planned", async () => {
  const onAction = vi.fn();
  const backlog = [
    task({
      id: 9,
      number: 54,
      key: "HOU-54",
      title: "Notion intake keeps assignee filter",
      status: "backlog",
      queue: "none",
    }),
  ];
  await using screen = await render(
    <TaskQueueView groups={queueTaskGroups(backlog)} onOpen={() => {}} onAction={onAction} />,
  );

  const plan = screen.getByRole("button", { name: "Plan" });
  await expect.element(plan).toHaveAttribute("aria-disabled", "true");
  await userEvent.hover(plan);
  await expect.element(page.getByText("Assign a workspace before planning.")).toBeVisible();
  expect(onAction).not.toHaveBeenCalled();
});

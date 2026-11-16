import type { HoustonTaskSummary } from "@houston-app/contracts/houston/tasks";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { TaskProjectView } from "./TaskProjectView";
import { groupTasksByProject } from "./tasks.logic";

function task(
  overrides: Partial<HoustonTaskSummary> &
    Pick<HoustonTaskSummary, "id" | "number" | "key" | "title">,
): HoustonTaskSummary {
  return {
    projectId: "p1" as never,
    status: "todo",
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
  task({ id: 1, number: 39, key: "HOU-39", title: "Pane header shows the branch" }),
  task({
    id: 2,
    number: 40,
    key: "HOU-40",
    title: "Branch label truncates",
    parentId: 1,
    status: "done",
  }),
  task({ id: 3, number: 46, key: "HOU-46", title: "Show PR number", parentId: 1 }),
  task({ id: 4, number: 53, key: "HOU-53", title: "Loose task", projectId: null as never }),
];

it("nests slices under their delivery and shows progress", async () => {
  const groups = groupTasksByProject(tasks, new Map([["p1", "Pane chrome"]]));
  await using screen = await render(
    <TaskProjectView
      groups={groups}
      onOpen={() => {}}
      onAction={() => {}}
      onOpenProject={() => {}}
    />,
  );

  expect(screen.container.textContent).toContain("Pane chrome");
  expect(screen.container.textContent).toContain("1 deliveries");
  expect(screen.container.textContent).toContain("1/2");
  expect(screen.container.textContent).toContain("HOU-40");
  expect(screen.container.textContent).toContain("No project");
  expect(screen.container.textContent).toContain("HOU-53");
  await expect
    .element(screen.getByRole("progressbar", { name: "Pane chrome slices done" }))
    .toHaveAttribute("aria-valuenow", "1");
});

it("collapses a project and opens its editor from the title", async () => {
  const onOpenProject = vi.fn();
  const groups = groupTasksByProject(tasks, new Map([["p1", "Pane chrome"]]));
  await using screen = await render(
    <TaskProjectView
      groups={groups}
      onOpen={() => {}}
      onAction={() => {}}
      onOpenProject={onOpenProject}
    />,
  );

  await screen.getByRole("button", { name: "Collapse Pane chrome" }).click();
  expect(screen.container.textContent).not.toContain("HOU-40");

  await screen.getByRole("button", { name: "Pane chrome" }).click();
  expect(onOpenProject).toHaveBeenCalledWith(expect.objectContaining({ title: "Pane chrome" }));
});

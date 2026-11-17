import type {
  HoustonTaskInitiative,
  HoustonTaskSummary,
} from "@houston-app/contracts/houston/tasks";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { TaskProjectPanel, TaskProjectView } from "./TaskProjectView";
import { groupTasksByProject } from "./tasks.logic";

const fixture = vi.hoisted(() => ({
  initiative: null as HoustonTaskInitiative | null,
  settings: null as Record<string, unknown> | null,
  calls: [] as unknown[],
}));

vi.mock("~/state/tasks", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    tasksEnvironment: { setSettings: {} },
    useTaskInitiativesResult: () =>
      AsyncResult.success(fixture.initiative === null ? [] : [fixture.initiative]),
    useTaskSettings: () => fixture.settings,
    refreshTaskInitiatives: () => {},
    refreshTaskDetail: () => {},
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async (value: unknown) => {
    fixture.calls.push(value);
    return { _tag: "Success" };
  },
}));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));

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
    issue: null,
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

it("shows and saves the project's switch that moves linked issues with their tasks", async () => {
  fixture.initiative = {
    id: 2,
    projectId: "p1" as never,
    name: "Pane chrome",
    externalUrl: null,
    trackerDescription: null,
    localDecisions: [],
    revision: 1,
    archivedAt: null,
  };
  fixture.settings = {
    access: "write",
    startModel: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    delivery: "send",
    reviewer: null,
    reviewMode: "manual",
    focus: "bugs",
    reworkRounds: 0,
    updateIssueState: false,
  };
  fixture.calls = [];
  const group = groupTasksByProject(tasks, new Map([["p1", "Pane chrome"]])).find(
    (entry) => entry.projectId === "p1",
  )!;
  await using screen = await render(
    <TaskProjectPanel environmentId={"env" as never} group={group} />,
  );

  expect(screen.container.textContent).toContain("Update the linked issue's state (Off)");
  await screen.getByRole("checkbox", { name: "Update the linked issue's state" }).click();

  expect(fixture.calls).toContainEqual({
    environmentId: "env",
    input: {
      projectId: "p1",
      settings: {
        access: "write",
        startModel: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        delivery: "send",
        reviewer: null,
        reviewMode: "manual",
        focus: "bugs",
        reworkRounds: 0,
        updateIssueState: true,
      },
    },
  });
  fixture.initiative = null;
  fixture.settings = null;
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

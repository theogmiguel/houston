import type { HoustonTaskDetail } from "@houston-app/contracts/houston/tasks";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const fixture = vi.hoisted(() => ({
  detail: null as HoustonTaskDetail | null,
  calls: [] as unknown[],
}));

vi.mock("~/state/tasks", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    tasksEnvironment: {
      save: {},
      comment: {},
      check: {},
      archive: {},
      saveDomain: {},
      saveInitiative: {},
      archiveInitiative: {},
      start: {},
      runControl: {},
      planStart: {},
      planAnswer: {},
      planApprove: {},
      reviewStart: {},
    },
    useTaskDetail: () => (fixture.detail === null ? null : AsyncResult.success(fixture.detail)),
    useTaskSettings: () => null,
    refreshTaskDetail: () => {},
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async (value: unknown) => {
    fixture.calls.push(value);
    return { _tag: "Success" };
  },
}));
vi.mock("~/state/environments", () => ({ useEnvironmentProviders: () => new Map() }));
vi.mock("~/threads/useOpenThread", () => ({ useOpenThread: () => async () => {} }));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));

import { TaskDetailPanel } from "./TaskDetailPanel";

function detail(overrides: Partial<HoustonTaskDetail> = {}): HoustonTaskDetail {
  return {
    task: {
      id: 45,
      number: 45,
      key: "HOU-45",
      projectId: "p1" as never,
      title: "Rename Harness review to Harness",
      description: "Update the sidebar label and the docs.",
      status: "in_review",
      priority: "high",
      parentId: null,
      refUrl: "https://github.com/acme/houston/issues/84",
      revision: 7,
      createdBy: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    },
    acceptance: [
      {
        id: 1,
        position: 0,
        text: "Sidebar and page title say Harness",
        checkedAt: "2026-01-02T00:00:00.000Z",
        checkedBy: "user",
      },
      {
        id: 2,
        position: 1,
        text: "Command palette finds Harness review as an alias",
        checkedAt: null,
        checkedBy: null,
      },
    ],
    comments: [
      {
        id: 4,
        body: "Looks good to merge.",
        author: "theo",
        createdAt: "2026-01-03T00:00:00.000Z",
      },
    ],
    history: [
      {
        id: 9,
        actor: "user",
        action: "houston:handback",
        changes: '{"status":{"old":"in_progress","new":"in_review"}}',
        createdAt: "2026-01-02T12:00:00.000Z",
      },
    ],
    runs: [
      {
        id: 12,
        taskId: 45,
        attempt: 1,
        kind: "implementation",
        state: "handed_back",
        provider: "claude",
        reviewer: null,
        threadId: "thread-1" as never,
        runId: null,
        worktreePath: null,
        branch: "houston/task/hou-45-rename-harness-review",
        baseCommit: null,
        initialRevision: 7,
        summary: "Done",
        reason: null,
        startedAt: "2026-01-02T00:00:00.000Z",
        endedAt: "2026-01-02T12:00:00.000Z",
        prUrl: null,
        review: null,
      },
    ],
    domain: {
      taskId: 45,
      kind: "slice",
      initiativeId: 2,
      deliveryId: 3,
      blockedBy: [],
      sliceTotal: 3,
      sliceDone: 1,
      readiness: {
        ready: true,
        reasons: [],
        acceptanceTotal: 2,
        unresolvedQuestions: 0,
        unfinishedBlockers: [],
      },
      plan: null,
    },
    planning: null,
    ...overrides,
  };
}

function panel() {
  return (
    <TaskDetailPanel
      environmentId={"env" as never}
      taskKey="HOU-45"
      projects={[{ id: "p1", title: "Houston" }]}
    />
  );
}

it("shows the task, its properties, acceptance and source", async () => {
  fixture.detail = detail();
  await using screen = await render(panel());

  expect(screen.container.textContent).toContain("Rename Harness review to Harness");
  expect(screen.container.textContent).toContain("In review");
  expect(screen.container.textContent).toContain("High");
  expect(screen.container.textContent).toContain("Houston");
  expect(screen.container.textContent).toContain("Update the sidebar label and the docs.");
  expect(screen.container.textContent).toContain("1/2");
  expect(screen.container.textContent).toContain("houston/task/hou-45-rename-harness-review");

  await expect.element(screen.getByRole("button", { name: "Review changes" })).toBeVisible();
});

it("ticks acceptance and comments from the activity tab", async () => {
  fixture.detail = detail();
  fixture.calls = [];
  await using screen = await render(panel());

  await screen.getByText("Command palette finds Harness review as an alias").click();
  expect(fixture.calls).toContainEqual({
    environmentId: "env",
    input: { id: "HOU-45", item: 2, checked: true },
  });

  await screen.getByRole("button", { name: /Activity/ }).click();
  expect(screen.container.textContent).toContain("Looks good to merge.");
  expect(screen.container.textContent).toContain("Handed the task back · In review");

  await screen.getByRole("textbox", { name: "Add a comment" }).fill("Ready for review");
  await screen.getByRole("button", { name: "Comment" }).click();
  expect(screen.container.textContent).toContain("Looks good to merge.");
});

it("answers a waiting attempt from the detail header", async () => {
  const base = detail();
  fixture.detail = {
    ...base,
    task: { ...base.task, status: "in_progress" },
    runs: [{ ...base.runs[0]!, state: "waiting_for_input", reason: "Which alias?" }],
  };
  await using screen = await render(panel());

  expect(screen.container.textContent).toContain("Which alias?");
  await expect.element(screen.getByRole("button", { name: "Answer" })).toBeVisible();
});

it("names the kind and saves it from the properties", async () => {
  fixture.detail = detail();
  fixture.calls = [];
  await using screen = await render(panel());

  await screen.getByRole("button", { name: "Change kind" }).click();
  await userEvent.click(page.getByRole("menuitem", { name: "Delivery" }));

  expect(fixture.calls).toContainEqual({
    environmentId: "env",
    input: { id: "HOU-45", expectedRevision: 7, kind: "delivery" },
  });
});

it("disables Plan with the reason a task cannot be planned", async () => {
  const base = detail();
  fixture.detail = {
    ...base,
    task: { ...base.task, status: "backlog" },
    runs: [],
    domain: { ...base.domain, kind: null },
  };
  fixture.calls = [];
  await using screen = await render(panel());

  const plan = screen.getByRole("button", { name: "Plan" });
  await expect.element(plan).toHaveAttribute("aria-disabled", "true");

  await userEvent.hover(plan);
  await expect
    .element(page.getByText("Set a kind (delivery or slice) before planning."))
    .toBeVisible();
  expect(fixture.calls).toEqual([]);
});

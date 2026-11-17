import type { IssueDetail } from "@houston-app/contracts";
import { EnvironmentId, ProjectId } from "@houston-app/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const fixture = vi.hoisted(() => {
  const token = (tag: string) => ({ tag });
  return {
    tokens: {
      task: token("task"),
      create: token("create"),
      start: token("start"),
      planStart: token("planStart"),
      save: token("save"),
      comment: token("comment"),
      check: token("check"),
      archive: token("archive"),
      saveDomain: token("saveDomain"),
      saveInitiative: token("saveInitiative"),
      archiveInitiative: token("archiveInitiative"),
      runControl: token("runControl"),
      planAnswer: token("planAnswer"),
      planApprove: token("planApprove"),
      reviewStart: token("reviewStart"),
      linkIssue: token("linkIssue"),
      unlinkIssue: token("unlinkIssue"),
    },
    linkedTask: null as Record<string, unknown> | null,
    createdTask: {
      id: 7,
      number: 7,
      key: "HOU-7",
      projectId: "p1",
      title: "Issue 12",
      description: "Tracked in #12",
      status: "backlog",
      priority: "none",
      parentId: null,
      refUrl: "https://github.com/acme/houston/issues/12",
      issue: null,
      revision: 1,
      createdBy: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    },
    calls: [] as unknown[],
  };
});

vi.mock("~/state/tasks", () => ({
  tasksEnvironment: {
    forIssue: () => fixture.tokens.task,
    save: fixture.tokens.save,
    comment: fixture.tokens.comment,
    check: fixture.tokens.check,
    archive: fixture.tokens.archive,
    saveDomain: fixture.tokens.saveDomain,
    saveInitiative: fixture.tokens.saveInitiative,
    archiveInitiative: fixture.tokens.archiveInitiative,
    start: fixture.tokens.start,
    runControl: fixture.tokens.runControl,
    planStart: fixture.tokens.planStart,
    planAnswer: fixture.tokens.planAnswer,
    planApprove: fixture.tokens.planApprove,
    reviewStart: fixture.tokens.reviewStart,
    createFromIssue: fixture.tokens.create,
    linkIssue: fixture.tokens.linkIssue,
    unlinkIssue: fixture.tokens.unlinkIssue,
  },
  loadTaskSettings: async () => ({
    access: "write",
    startModel: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    delivery: "send",
    reviewer: null,
    reviewMode: "manual",
    focus: "bugs",
    reworkRounds: 0,
  }),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: fixture.linkedTask,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: () => {},
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (atom: { tag?: string }) => async (value: unknown) => {
    fixture.calls.push({ tag: atom?.tag, value });
    if (atom?.tag === "create") return { _tag: "Success", value: fixture.createdTask };
    if (atom?.tag === "start") return { _tag: "Success", value: { run: { threadId: null } } };
    if (atom?.tag === "planStart") return { _tag: "Success", value: { planning: null } };
    return { _tag: "Success", value: null };
  },
}));
vi.mock("~/threads/useOpenThread", () => ({ useOpenThread: () => async () => {} }));

import { IssueTaskSection } from "./IssueTaskSection";

const issue = (): IssueDetail => ({
  projectId: ProjectId.make("p1"),
  projectTitle: "Houston",
  tracker: "github" as never,
  host: "github.com",
  scope: "acme/houston",
  key: "12",
  displayKey: "#12",
  title: "Fix the flaky test",
  url: "https://github.com/acme/houston/issues/12",
  author: { login: "theo", name: null, avatarUrl: null },
  state: { category: "open", name: "Open" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  closedAt: null,
  assignees: [],
  labels: [],
  commentCount: 0,
  writable: true,
  capabilities: {
    create: true,
    edit: true,
    comment: true,
    labels: true,
    assignees: true,
    reactions: false,
    templates: false,
    linkedPullRequests: false,
    events: false,
    search: false,
  },
  viewerPermissions: {
    setState: true,
    comment: true,
    edit: true,
    labels: true,
    assignees: true,
  },
  states: [
    { category: "open", name: "Open" },
    { category: "closed", name: "Completed", closeReason: "completed" },
  ],
  viewer: "theo",
  body: "The test fails on Windows.",
  comments: [],
  commentsCursor: null,
  events: [],
  linkedPullRequests: [],
});

function section() {
  return <IssueTaskSection environmentId={EnvironmentId.make("env")} detail={issue()} />;
}

it("offers to create a task from the issue", async () => {
  fixture.linkedTask = null;
  fixture.calls = [];
  await using screen = await render(section());

  await expect.element(screen.getByRole("button", { name: "Create task" })).toBeVisible();
  await screen.getByRole("button", { name: "Create task" }).click();

  expect(fixture.calls).toContainEqual({
    tag: "create",
    value: {
      environmentId: "env",
      input: {
        projectId: "p1",
        tracker: "github",
        host: "github.com",
        scope: "acme/houston",
        key: "12",
      },
    },
  });
  expect(screen.container.textContent).toContain("HOU-7");
  expect(screen.container.textContent).toContain("Backlog");
});

it("start creates the task and then starts it", async () => {
  fixture.linkedTask = null;
  fixture.calls = [];
  await using screen = await render(section());

  await screen.getByRole("button", { name: "Start" }).click();

  expect(fixture.calls).toContainEqual({ tag: "create", value: expect.anything() });
  expect(fixture.calls).toContainEqual({
    tag: "start",
    value: { environmentId: "env", input: { id: "HOU-7", projectId: "p1" } },
  });
});

it("plan creates the task and starts the planner with the project's start model", async () => {
  fixture.linkedTask = null;
  fixture.calls = [];
  await using screen = await render(section());

  await screen.getByRole("button", { name: "Plan" }).click();

  expect(fixture.calls).toContainEqual({ tag: "create", value: expect.anything() });
  expect(fixture.calls).toContainEqual({
    tag: "planStart",
    value: {
      environmentId: "env",
      input: {
        id: "HOU-7",
        expectedRevision: 1,
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      },
    },
  });
});

it("shows the linked task and opens it on the Tasks page", async () => {
  fixture.linkedTask = {
    id: 9,
    number: 9,
    key: "HOU-9",
    projectId: "p1",
    title: "Fix the flaky test",
    status: "in_progress",
    priority: "high",
    parentId: null,
    refUrl: null,
    issue: null,
    revision: 3,
    createdBy: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    archivedAt: null,
    acceptanceChecked: 1,
    acceptanceTotal: 2,
    queue: "stopped",
    ready: true,
    domainKind: null,
    openRun: null,
  };
  fixture.calls = [];
  await using screen = await render(section());

  expect(screen.container.textContent).toContain("HOU-9");
  expect(screen.container.textContent).toContain("In progress");
  expect(screen.container.textContent).not.toContain("Create task");

  await screen.getByRole("button", { name: "Open HOU-9" }).click();
  expect(screen.router?.state.location.pathname).toBe("/tasks");
  expect(screen.router?.state.location.search).toMatchObject({ task: "HOU-9" });
});

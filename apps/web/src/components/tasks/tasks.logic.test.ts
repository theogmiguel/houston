import type { HoustonTaskSummary } from "@houston-app/contracts/houston/tasks";

import { describe, expect, it } from "vite-plus/test";

import {
  describeHistoryEntry,
  groupTasksByProject,
  queueTaskGroups,
  taskActivity,
  taskDetailAction,
  taskKeysInText,
  taskNextAction,
  taskStatusLine,
} from "./tasks.logic.ts";

function summary(
  overrides: Partial<HoustonTaskSummary> & Pick<HoustonTaskSummary, "id" | "number" | "key">,
): HoustonTaskSummary {
  return {
    projectId: null,
    title: `Task ${overrides.number}`,
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

describe("taskNextAction", () => {
  it("answers a waiting run and reviews a handed-back one", () => {
    expect(
      taskNextAction(
        summary({
          id: 1,
          number: 1,
          key: "HOU-1",
          status: "in_progress",
          queue: "your_turn",
          openRun: {
            id: 5,
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
            reason: null,
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: null,
            prUrl: null,
            review: null,
          },
        }),
      ),
    ).toEqual({ kind: "answer", label: "Answer" });
    expect(
      taskNextAction(
        summary({ id: 2, number: 2, key: "HOU-2", status: "in_review", queue: "your_turn" }),
      ),
    ).toEqual({ kind: "review", label: "Review changes" });
  });

  it("resumes stopped work, starts ready work and plans backlog work", () => {
    expect(
      taskNextAction(
        summary({ id: 1, number: 1, key: "HOU-1", status: "in_progress", queue: "stopped" }),
      ),
    ).toEqual({ kind: "resume", label: "Resume" });
    expect(
      taskNextAction(
        summary({ id: 2, number: 2, key: "HOU-2", status: "todo", queue: "up_next", ready: true }),
      ),
    ).toEqual({ kind: "start", label: "Start" });
    expect(taskNextAction(summary({ id: 3, number: 3, key: "HOU-3" }))).toEqual({
      kind: "plan",
      label: "Plan",
    });
  });

  it("offers nothing for live work or folded tasks", () => {
    expect(
      taskNextAction(
        summary({ id: 1, number: 1, key: "HOU-1", status: "in_progress", queue: "working" }),
      ),
    ).toBeNull();
    expect(taskNextAction(summary({ id: 2, number: 2, key: "HOU-2", status: "done" }))).toBeNull();
  });
});

describe("taskDetailAction", () => {
  const base = {
    task: {
      id: 1,
      number: 1,
      key: "HOU-1",
      projectId: null,
      title: "Task",
      description: "",
      status: "todo" as const,
      priority: "none" as const,
      parentId: null,
      refUrl: null,
      revision: 1,
      createdBy: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    },
    acceptance: [],
    comments: [],
    history: [],
    runs: [],
    domain: {
      taskId: 1,
      kind: null,
      initiativeId: null,
      deliveryId: null,
      blockedBy: [],
      sliceTotal: 0,
      sliceDone: 0,
      readiness: {
        ready: false,
        reasons: [],
        acceptanceTotal: 0,
        unresolvedQuestions: 0,
        unfinishedBlockers: [],
      },
      plan: null,
    },
    planning: null,
  };
  it("starts a todo task and plans a backlog one", () => {
    expect(taskDetailAction(base)).toEqual({ kind: "start", label: "Start" });
    expect(taskDetailAction({ ...base, task: { ...base.task, status: "backlog" } })).toEqual({
      kind: "plan",
      label: "Plan",
    });
  });

  it("answers a waiting run and resumes a stopped one", () => {
    expect(
      taskDetailAction({
        ...base,
        task: { ...base.task, status: "in_progress" },
        runs: [
          {
            id: 7,
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
            reason: null,
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: null,
            prUrl: null,
            review: null,
          },
        ],
      }),
    ).toEqual({ kind: "answer", label: "Answer" });
    expect(
      taskDetailAction({
        ...base,
        task: { ...base.task, status: "in_progress" },
      }),
    ).toEqual({ kind: "resume", label: "Resume" });
  });
});

describe("taskStatusLine", () => {
  it("names missing acceptance items and generic unreadiness", () => {
    expect(taskStatusLine(summary({ id: 1, number: 1, key: "HOU-1" }))).toEqual({
      tone: "warning",
      text: "No acceptance items",
    });
    expect(
      taskStatusLine(summary({ id: 2, number: 2, key: "HOU-2", acceptanceTotal: 2, ready: false })),
    ).toEqual({ tone: "warning", text: "Not ready" });
  });

  it("shows the branch while an agent works", () => {
    expect(
      taskStatusLine(
        summary({
          id: 3,
          number: 3,
          key: "HOU-3",
          status: "in_progress",
          queue: "working",
          openRun: {
            id: 9,
            taskId: 3,
            attempt: 1,
            kind: "implementation",
            state: "running",
            provider: "claude",
            reviewer: null,
            threadId: null,
            runId: null,
            worktreePath: null,
            branch: "houston/task/hou-3-slug",
            baseCommit: null,
            initialRevision: 1,
            summary: null,
            reason: null,
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: null,
            prUrl: null,
            review: null,
          },
        }),
      ),
    ).toEqual({ tone: "default", text: "houston/task/hou-3-slug" });
  });
});

describe("queueTaskGroups", () => {
  it("groups open work, counts folded tasks and filters by query", () => {
    const tasks = [
      summary({ id: 1, number: 1, key: "HOU-1", status: "in_review", queue: "your_turn" }),
      summary({ id: 2, number: 2, key: "HOU-2", status: "in_progress", queue: "working" }),
      summary({ id: 3, number: 3, key: "HOU-3", status: "done" }),
      summary({ id: 4, number: 4, key: "HOU-4", title: "Filter tasks by workspace" }),
    ];
    const groups = queueTaskGroups(tasks);
    expect(groups.sections.map((section) => section.section)).toEqual([
      "your_turn",
      "working",
      "backlog",
    ]);
    expect(groups.folded.map((task) => task.key)).toEqual(["HOU-3"]);

    const filtered = queueTaskGroups(tasks, { query: "workspace" });
    expect(filtered.sections.flatMap((section) => section.tasks).map((task) => task.key)).toEqual([
      "HOU-4",
    ]);
  });
});

describe("groupTasksByProject", () => {
  it("nests slices under their delivery and keeps loose tasks", () => {
    const tasks = [
      summary({ id: 1, number: 1, key: "HOU-1", projectId: "p1" as never, title: "Delivery" }),
      summary({
        id: 2,
        number: 2,
        key: "HOU-2",
        projectId: "p1" as never,
        parentId: 1,
        status: "done",
      }),
      summary({ id: 3, number: 3, key: "HOU-3", projectId: "p1" as never, parentId: 1 }),
      summary({ id: 4, number: 4, key: "HOU-4", title: "Loose" }),
    ];
    const groups = groupTasksByProject(tasks, new Map([["p1", "Houston"]]));
    expect(groups.map((group) => group.title)).toEqual(["Houston", "No project"]);
    const houston = groups[0];
    expect(houston?.deliveries[0]?.slices.map((slice) => slice.key)).toEqual(["HOU-3", "HOU-2"]);
    expect(houston?.sliceDone).toBe(1);
    expect(houston?.sliceTotal).toBe(2);
    expect(groups[1]?.loose.map((task) => task.key)).toEqual(["HOU-4"]);
  });
});

describe("activity", () => {
  it("merges comments and changes oldest first and names known actions", () => {
    const items = taskActivity(
      [{ id: 1, body: "Looks good", author: "theo", createdAt: "2026-01-02T00:00:00.000Z" }],
      [
        {
          id: 2,
          actor: "user",
          action: "houston:start",
          changes: '{"status":{"old":"todo","new":"in_progress"}}',
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    );
    expect(items.map((item) => item.kind)).toEqual(["history", "comment"]);
    expect(
      describeHistoryEntry({
        id: 2,
        actor: "user",
        action: "houston:start",
        changes: '{"status":{"old":"todo","new":"in_progress"}}',
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("Started the task · In progress");
  });
});

describe("taskKeysInText", () => {
  it("finds upper-case keys only", () => {
    expect(taskKeysInText("hou-3 then HOU-12 and HOU-0")).toEqual(["HOU-3", "HOU-12"]);
  });
});

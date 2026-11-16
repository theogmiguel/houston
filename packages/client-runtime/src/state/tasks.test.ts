import type { HoustonTaskSummary } from "@houston-app/contracts/houston/tasks";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_TASKS_SNAPSHOT,
  applyTasksStreamEvent,
  compareTasksForQueue,
  taskCountsOf,
  taskIsFolded,
  taskQueueSection,
} from "./tasks.ts";

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

describe("applyTasksStreamEvent", () => {
  it("replaces the list on a snapshot and marks it loaded", () => {
    const next = applyTasksStreamEvent(EMPTY_TASKS_SNAPSHOT, {
      snapshot: {
        tasks: [summary({ id: 1, number: 1, key: "HOU-1", queue: "your_turn" })],
        counts: {
          yourTurn: 1,
          ready: 0,
          backlog: 0,
          todo: 0,
          inProgress: 0,
          inReview: 0,
          done: 0,
          canceled: 0,
        },
        truncated: false,
      },
    });
    expect(next.loaded).toBe(true);
    expect(next.tasks.map((task) => task.key)).toEqual(["HOU-1"]);
    expect(next.counts.yourTurn).toBe(1);
  });

  it("upserts a changed summary and recounts", () => {
    const base = {
      ...EMPTY_TASKS_SNAPSHOT,
      loaded: true,
      tasks: [summary({ id: 1, number: 1, key: "HOU-1" })],
    };
    const changed = summary({
      id: 1,
      number: 1,
      key: "HOU-1",
      status: "in_progress",
      queue: "working",
    });
    const next = applyTasksStreamEvent(base, { changed });
    expect(next.tasks).toHaveLength(1);
    expect(next.tasks[0]?.status).toBe("in_progress");
    expect(next.counts.inProgress).toBe(1);
  });

  it("appends a task the snapshot did not hold", () => {
    const base = { ...EMPTY_TASKS_SNAPSHOT, loaded: true };
    const next = applyTasksStreamEvent(base, {
      changed: summary({
        id: 2,
        number: 2,
        key: "HOU-2",
        status: "todo",
        queue: "up_next",
        ready: true,
      }),
    });
    expect(next.tasks).toHaveLength(1);
    expect(next.counts.ready).toBe(1);
  });

  it("drops a removed task and counts again", () => {
    const base = {
      ...EMPTY_TASKS_SNAPSHOT,
      loaded: true,
      tasks: [
        summary({ id: 1, number: 1, key: "HOU-1", status: "todo", queue: "up_next", ready: true }),
      ],
    };
    const next = applyTasksStreamEvent(base, { removed: { id: 1 } });
    expect(next.tasks).toEqual([]);
    expect(next.counts.ready).toBe(0);
  });

  it("keeps the same object when a removal names no held task", () => {
    expect(applyTasksStreamEvent(EMPTY_TASKS_SNAPSHOT, { removed: { id: 9 } })).toBe(
      EMPTY_TASKS_SNAPSHOT,
    );
  });
});

describe("taskCountsOf", () => {
  it("counts your turn by queue and ignores archived tasks", () => {
    const counts = taskCountsOf([
      summary({ id: 1, number: 1, key: "HOU-1", status: "in_review", queue: "your_turn" }),
      summary({ id: 2, number: 2, key: "HOU-2", status: "in_progress", queue: "working" }),
      summary({ id: 3, number: 3, key: "HOU-3", status: "todo", queue: "up_next", ready: true }),
      summary({
        id: 4,
        number: 4,
        key: "HOU-4",
        status: "done",
        queue: "none",
        archivedAt: "2026-01-02T00:00:00.000Z",
      }),
    ]);
    expect(counts).toEqual({
      yourTurn: 1,
      ready: 1,
      backlog: 0,
      todo: 1,
      inProgress: 1,
      inReview: 1,
      done: 0,
      canceled: 0,
    });
  });
});

describe("queue sections", () => {
  it("folds done, canceled and archived tasks", () => {
    expect(taskIsFolded(summary({ id: 1, number: 1, key: "HOU-1", status: "done" }))).toBe(true);
    expect(taskIsFolded(summary({ id: 2, number: 2, key: "HOU-2", status: "canceled" }))).toBe(
      true,
    );
    expect(
      taskIsFolded(
        summary({
          id: 3,
          number: 3,
          key: "HOU-3",
          status: "todo",
          archivedAt: "2026-01-02T00:00:00.000Z",
        }),
      ),
    ).toBe(true);
    expect(taskIsFolded(summary({ id: 4, number: 4, key: "HOU-4", status: "todo" }))).toBe(false);
  });

  it("places unqueued work in backlog and keeps server queues", () => {
    expect(taskQueueSection(summary({ id: 1, number: 1, key: "HOU-1" }))).toBe("backlog");
    expect(
      taskQueueSection(
        summary({ id: 2, number: 2, key: "HOU-2", status: "in_review", queue: "your_turn" }),
      ),
    ).toBe("your_turn");
  });

  it("orders up next by priority, then age, then number", () => {
    const urgent = summary({ id: 1, number: 3, key: "HOU-3", priority: "urgent" });
    const highOld = summary({
      id: 2,
      number: 4,
      key: "HOU-4",
      priority: "high",
      createdAt: "2025-12-01T00:00:00.000Z",
    });
    const highNew = summary({ id: 3, number: 2, key: "HOU-2", priority: "high" });
    expect([highNew, urgent, highOld].toSorted(compareTasksForQueue)).toEqual([
      urgent,
      highOld,
      highNew,
    ]);
  });
});

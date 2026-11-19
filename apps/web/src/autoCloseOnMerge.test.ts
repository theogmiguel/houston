import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  detectAutoClosedOnMerge,
  forgetLocallySettled,
  locallySettledThreadKeys,
  noteLocallySettled,
} from "./autoCloseOnMerge";

const environmentId = EnvironmentId.make("env-1");

function thread(
  id = "t1",
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id,
    environmentId,
    projectId: "p1",
    title: id,
    pullRequests: [],
    settledOverride: null,
    settledAt: null,
    archivedAt: null,
    deletedAt: null,
    lineage: {
      relationshipToParent: null,
      parentThreadId: null,
      rootThreadId: ThreadId.make(id),
      sideChat: false,
    },
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

function pullRequest(state: "open" | "closed" | "merged", mergedAt: string | null = null) {
  return {
    host: "github.com",
    repository: "owner/repository",
    number: 1,
    url: "https://github.com/owner/repository/pull/1",
    source: "agent",
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot: {
      state,
      title: "A pull request",
      headBranch: "feature",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-01-01T00:00:00.000Z",
      closedAt: null,
      mergedAt,
    },
    stack: null,
  };
}

const keyOf = (id = "t1") => scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));

const noLocalSettles: ReadonlySet<string> = new Set();

describe("detectAutoClosedOnMerge", () => {
  it("detects a thread going from open to closed with a merged pull request", () => {
    const next = thread("t1", {
      settledOverride: "settled",
      settledAt: "2026-01-02T00:00:00.000Z",
      pullRequests: [pullRequest("merged", "2026-01-02T00:00:00.000Z")],
    } as Partial<EnvironmentThreadShell>);

    expect(detectAutoClosedOnMerge(thread(), next, noLocalSettles)).toBe(true);
  });

  it("ignores a thread that was already closed", () => {
    const settled = thread("t1", { settledOverride: "settled" });
    const next = thread("t1", {
      settledOverride: "settled",
      pullRequests: [pullRequest("merged", "2026-01-02T00:00:00.000Z")],
    } as Partial<EnvironmentThreadShell>);

    expect(detectAutoClosedOnMerge(settled, next, noLocalSettles)).toBe(false);
  });

  it("ignores a thread this client closed itself", () => {
    const next = thread("t1", {
      settledOverride: "settled",
      pullRequests: [pullRequest("merged", "2026-01-02T00:00:00.000Z")],
    } as Partial<EnvironmentThreadShell>);

    expect(detectAutoClosedOnMerge(thread(), next, new Set([keyOf()]))).toBe(false);
  });

  it("ignores a closed thread whose pull request did not merge", () => {
    const next = thread("t1", {
      settledOverride: "settled",
      pullRequests: [pullRequest("closed")],
    } as Partial<EnvironmentThreadShell>);

    expect(detectAutoClosedOnMerge(thread(), next, noLocalSettles)).toBe(false);
  });

  it("ignores a thread whose pull request is still open", () => {
    const next = thread("t1", {
      settledOverride: "settled",
      pullRequests: [pullRequest("open")],
    } as Partial<EnvironmentThreadShell>);

    expect(detectAutoClosedOnMerge(thread(), next, noLocalSettles)).toBe(false);
  });

  it("ignores archived, deleted and subagent threads", () => {
    const merged = { pullRequests: [pullRequest("merged", "2026-01-02T00:00:00.000Z")] };
    const next = (overrides: Partial<EnvironmentThreadShell>) =>
      thread("t1", {
        ...merged,
        settledOverride: "settled",
        ...overrides,
      } as Partial<EnvironmentThreadShell>);

    expect(
      detectAutoClosedOnMerge(
        thread(),
        next({ archivedAt: "2026-01-02T00:00:00.000Z" }),
        noLocalSettles,
      ),
    ).toBe(false);
    expect(
      detectAutoClosedOnMerge(
        thread(),
        next({ deletedAt: "2026-01-02T00:00:00.000Z" }),
        noLocalSettles,
      ),
    ).toBe(false);
    expect(
      detectAutoClosedOnMerge(
        thread(),
        next({
          lineage: {
            relationshipToParent: "subagent",
            parentThreadId: ThreadId.make("parent"),
            rootThreadId: ThreadId.make("parent"),
            sideChat: false,
          },
        }),
        noLocalSettles,
      ),
    ).toBe(false);
  });
});

describe("locallySettledThreadKeys", () => {
  it("records the threads this client settles, then forgets them", () => {
    const first = scopeThreadRef(environmentId, ThreadId.make("t1"));
    const second = scopeThreadRef(environmentId, ThreadId.make("t2"));
    const key = noteLocallySettled(first);
    noteLocallySettled(second);

    expect(locallySettledThreadKeys().has(key)).toBe(true);
    expect(locallySettledThreadKeys().has(keyOf("t2"))).toBe(true);

    forgetLocallySettled(key);
    expect(locallySettledThreadKeys().has(key)).toBe(false);
    forgetLocallySettled(keyOf("t2"));
  });
});

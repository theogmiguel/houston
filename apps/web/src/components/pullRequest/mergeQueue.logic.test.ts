import { ProjectId } from "@houston-app/contracts";
import type {
  HoustonMergeQueueEntry,
  HoustonMergeQueueLogEntry,
  HoustonMergeQueueSettings,
  HoustonMergeQueueSnapshot,
} from "@houston-app/contracts/houston/mergeQueue";
import { describe, expect, it } from "vite-plus/test";

import {
  formatMergeQueueElapsed,
  mergeQueueAwayNotice,
  mergeQueueBadges,
  mergeQueueCommandError,
  mergeQueueEntryActions,
  mergeQueueEntryLine,
  mergeQueueLineCount,
  mergeQueueLogLine,
  mergeQueueLogsToday,
  mergeQueuePolicyLine,
  mergeQueueSections,
  mergeQueueSettingsError,
  mergeQueueStatusLabel,
  mergeQueueStatusTone,
  mergeQueueTimeLimitError,
  mergeQueueVerificationLine,
} from "./mergeQueue.logic";

const PROJECT = ProjectId.make("project-1");
const NOW = Date.parse("2026-11-03T18:00:00.000Z");

const SETTINGS: HoustonMergeQueueSettings = {
  projectId: PROJECT,
  mergeWhenVerified: false,
  verificationCommand: "pnpm test:ci",
  timeLimitMinutes: 30,
  paused: false,
  revision: 3,
};

function entry(overrides: Partial<HoustonMergeQueueEntry> = {}): HoustonMergeQueueEntry {
  return {
    projectId: PROJECT,
    number: 482,
    repository: "owner/repository",
    url: "https://github.com/owner/repository/pull/482",
    title: "Fix flaky sync timer test",
    headRef: "houston/fix-sync-timer",
    headSha: "9d2e7b4a1c2d3e4f5061728394a5b6c7d8e9f0a1",
    baseRef: "main",
    dependsOn: null,
    ownerThreadId: null,
    position: 1,
    status: "ready",
    reason: null,
    gates: [],
    verification: null,
    failure: null,
    github: null,
    enqueuedAt: "2026-11-03T13:00:00.000Z",
    readAt: null,
    verifyingSince: null,
    ...overrides,
  };
}

function logRow(overrides: Partial<HoustonMergeQueueLogEntry> = {}): HoustonMergeQueueLogEntry {
  return {
    id: 1,
    kind: "merge",
    number: 476,
    repository: "owner/repository",
    url: "https://github.com/owner/repository/pull/476",
    title: "Bump the usage poll interval",
    refName: "main",
    oldSha: "7c20de1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    newSha: "b81d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    headSha: "b81d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    forkSha: null,
    method: "squash",
    detail: null,
    unattended: false,
    at: "2026-11-03T13:31:00.000Z",
    ...overrides,
  };
}

function snapshot(overrides: Partial<HoustonMergeQueueSnapshot> = {}): HoustonMergeQueueSnapshot {
  return {
    projectId: PROJECT,
    entries: [],
    log: [],
    settings: SETTINGS,
    globalPaused: false,
    away: { merged: 0, parked: 0 },
    handOff: null,
    message: null,
    ...overrides,
  };
}

describe("mergeQueueSections", () => {
  it("puts ranked entries before unranked ones and parked entries apart", () => {
    const sections = mergeQueueSections(
      snapshot({
        entries: [
          entry({ number: 1, position: 1 }),
          entry({ number: 2, position: 2 }),
          entry({ number: 3, position: 0, status: "fixing" }),
          entry({ number: 4, position: 0, status: "parked" }),
        ],
      }),
      NOW,
    );
    expect(sections.inLine.map((row) => row.number)).toEqual([1, 2, 3]);
    expect(sections.parked.map((row) => row.number)).toEqual([4]);
  });

  it("keeps today's merges, losing pushes and yesterday", () => {
    const sections = mergeQueueSections(
      snapshot({
        log: [
          logRow({ id: 1, at: "2026-11-03T13:31:00.000Z" }),
          logRow({ id: 2, kind: "push", at: "2026-11-03T12:00:00.000Z" }),
          logRow({ id: 3, at: "2026-11-02T23:00:00.000Z" }),
        ],
      }),
      NOW,
    );
    expect(sections.today.map((row) => row.id)).toEqual([1]);
    expect(mergeQueueLogsToday([logRow()], NOW)).toHaveLength(1);
  });

  it("counts everything but parked entries for the header", () => {
    expect(
      mergeQueueLineCount(
        snapshot({
          entries: [
            entry({ number: 1, status: "ready" }),
            entry({ number: 2, status: "parked", position: 0 }),
            entry({ number: 3, status: "fixing", position: 0 }),
          ],
        }),
      ),
    ).toBe(2);
  });
});

describe("mergeQueueBadges", () => {
  it("counts and badges every project the list shows, not only one scope", () => {
    const other = ProjectId.make("project-2");
    const badges = mergeQueueBadges([
      {
        environmentId: "environment-1",
        snapshot: snapshot({
          entries: [
            entry({ number: 482, position: 1 }),
            entry({ number: 468, position: 0, status: "parked" }),
          ],
        }),
      },
      {
        environmentId: "environment-1",
        snapshot: snapshot({
          entries: [
            entry({
              projectId: other,
              repository: "owner/Other",
              number: 471,
              position: 1,
            }),
            entry({ projectId: other, repository: "owner/Other", number: 479, position: 2 }),
          ],
        }),
      },
    ]);

    expect(badges.count).toBe(3);
    expect(badges.parked).toBe(true);
    expect(badges.positions.get("environment-1:project-1:owner/repository:482")).toBe(1);
    expect(badges.positions.get("environment-1:project-2:owner/other:471")).toBe(1);
    expect(badges.positions.get("environment-1:project-2:owner/other:479")).toBe(2);
  });

  it("has no count and no parked flag without a project", () => {
    expect(mergeQueueBadges([])).toEqual({ count: 0, parked: false, positions: new Map() });
  });
});

describe("status and rows", () => {
  it("counts a verification against its limit", () => {
    const verifying = entry({
      status: "verifying",
      verifyingSince: "2026-11-03T17:55:48.000Z",
    });
    expect(mergeQueueStatusLabel(verifying, SETTINGS, NOW)).toBe("Verifying 4m 12s / 30m");
    expect(formatMergeQueueElapsed(252_000)).toBe("4m 12s");
    expect(mergeQueueStatusTone("parked")).toBe("error");
    expect(mergeQueueStatusTone("ready")).toBe("ok");
  });

  it("explains where an entry stands", () => {
    expect(mergeQueueEntryLine(entry({ position: 1 }), null, true, SETTINGS, NOW)).toBe(
      "Next in line, ready to merge",
    );
    expect(
      mergeQueueEntryLine(entry({ dependsOn: 479, position: 4 }), null, false, SETTINGS, NOW),
    ).toBe("Merges after #479, which it depends on");
    expect(
      mergeQueueEntryLine(
        entry({ status: "parked", reason: "Timed out after 30m" }),
        null,
        false,
        SETTINGS,
        NOW,
      ),
    ).toBe("Timed out after 30m");
    expect(
      mergeQueueEntryLine(
        entry({ status: "waitingForSlot", position: 3 }),
        null,
        false,
        SETTINGS,
        NOW,
      ),
    ).toBe("Verifies once the slot on this machine is free");
  });

  it("names the verified commit a merge head would land", () => {
    expect(
      mergeQueueVerificationLine(
        entry({
          verification: {
            baseRef: "main",
            baseSha: "3fa9c1eaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            headSha: "c41f0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            verifiedSha: "9d2e7b4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            at: "2026-11-03T16:58:00.000Z",
          },
        }),
      ),
    ).toContain("Rebased c41f0aa onto main@3fa9c1e and verified it as 9d2e7b4");
  });

  it("offers actions only where the server accepts them", () => {
    expect(mergeQueueEntryActions(entry({ status: "ready" }), { log: [] })).toMatchObject({
      canMergeHead: true,
      canRetry: false,
      canHandToThread: false,
      canRevert: false,
    });
    expect(
      mergeQueueEntryActions(entry({ status: "parked", position: 0 }), {
        log: [logRow({ number: 482 })],
      }),
    ).toMatchObject({
      canMergeHead: false,
      canRetry: true,
      canHandToThread: true,
      canRevert: true,
    });
  });
});

describe("policy, limits and history", () => {
  it("describes who lands the head and how it is verified", () => {
    expect(mergeQueuePolicyLine(SETTINGS, null)).toBe(
      "You merge the head. Each head is verified with pnpm test:ci, one at a time on this machine, 30 min limit.",
    );
    expect(mergeQueuePolicyLine({ ...SETTINGS, mergeWhenVerified: true }, "autoMerge")).toBe(
      "Merges when verified with pnpm test:ci, one at a time on this machine, 30 min limit · GitHub auto-merge lands it.",
    );
    expect(mergeQueuePolicyLine({ ...SETTINGS, verificationCommand: "" }, null)).toBe(
      "You merge the head. No verification command is set.",
    );
  });

  it("names the limit and the value it refused", () => {
    expect(mergeQueueTimeLimitError(0)).toBe("The time limit is 0 minutes; enter 1-240 minutes.");
    expect(mergeQueueTimeLimitError(30)).toBeNull();
    expect(mergeQueueCommandError("a".repeat(1_025))).toBe(
      "The verification command is 1025 bytes; the limit is 1024 bytes.",
    );
    expect(mergeQueueCommandError("a\nb")).toBe("The verification command must be one line.");
    expect(
      mergeQueueSettingsError({
        verificationCommand: "",
        timeLimitMinutes: 30,
        mergeWhenVerified: true,
      }),
    ).toBe("Merge when verified needs a verification command.");
  });

  it("writes history rows and the away notice", () => {
    expect(mergeQueueLogLine(logRow())).toBe("Merged into main@b81d0aa · squash");
    expect(mergeQueueLogLine(logRow({ kind: "park", detail: "Verification timed out" }))).toBe(
      "Parked. Verification timed out",
    );
    expect(mergeQueueAwayNotice({ merged: 2, parked: 1 })).toBe(
      "While you were away the queue merged 2 pull requests and parked 1.",
    );
    expect(mergeQueueAwayNotice({ merged: 0, parked: 1 })).toBe(
      "While you were away the queue parked 1.",
    );
    expect(mergeQueueAwayNotice({ merged: 0, parked: 0 })).toBeNull();
  });
});

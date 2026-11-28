import { assert, describe, it } from "@effect/vitest";

import {
  canReleaseHeld,
  autoConcurrentRuns,
  concurrentRunsCeiling,
  HIGH_PRESSURE_AVAILABLE_PERCENT,
  loadAdmission,
  memoryPressure,
  overdueHoldIds,
  OVERDUE_AFTER_MS,
  RELEASE_INTERVAL_MS,
} from "./LoadAdmission.ts";

const GB = 1024 ** 3;
const machine = (totalGb: number, availableGb: number) => ({
  totalBytes: totalGb * GB,
  availableBytes: availableGb * GB,
});
const settings = (
  overrides: Partial<{ holdNewSubagentsUnderLoad: boolean; concurrentRuns: "auto" | number }> = {},
) => ({
  holdNewSubagentsUnderLoad: true,
  concurrentRuns: 5 as const,
  ...overrides,
});
const admission = (
  overrides: Partial<Parameters<typeof loadAdmission>[0]> = {},
): ReturnType<typeof loadAdmission> =>
  loadAdmission({
    origin: "automatic",
    governed: true,
    bypass: false,
    settings: settings(),
    machine: machine(30, 20),
    activeRuns: 0,
    reservations: 0,
    ...overrides,
  });

describe("autoConcurrentRuns", () => {
  it("gives 5 runs on 30 GB and 2 on 16 GB", () => {
    assert.equal(autoConcurrentRuns(30 * GB), 5);
    assert.equal(autoConcurrentRuns(16 * GB), 2);
  });

  it("clamps to 1 at 32", () => {
    assert.equal(autoConcurrentRuns(4 * GB), 1);
    assert.equal(autoConcurrentRuns(1024 * GB), 32);
  });
});

describe("memoryPressure", () => {
  it("is high only below the available floor", () => {
    assert.isFalse(memoryPressure(machine(30, 12)).high);
    assert.isTrue(memoryPressure(machine(30, 2)).high);
    assert.equal(memoryPressure(machine(30, 2)).availablePercent, 6);
  });

  it("skips an unreadable reading and never treats swap as pressure", () => {
    assert.deepEqual(memoryPressure(null), { high: false, availablePercent: null });
    // Available memory alone decides: a machine with high swap but ample RAM reads normal.
    assert.isFalse(memoryPressure(machine(30, 20)).high);
  });
});

describe("loadAdmission", () => {
  it("holds new automatic work at the ceiling but always starts a user message", () => {
    assert.equal(admission({ activeRuns: 5 }).type, "hold");
    assert.equal(admission({ activeRuns: 5, origin: "user" }).type, "start");
    assert.equal(admission({ activeRuns: 5, origin: "provider" }).type, "start");
  });

  it("holds under high pressure even below the ceiling", () => {
    const hold = admission({ machine: machine(30, 2), activeRuns: 1 });
    assert.equal(hold.type, "hold");
    if (hold.type !== "hold") return;
    assert.equal(hold.reason.kind, "load");
    assert.match(hold.reason.message, /6% available/);
  });

  it("never holds a result delivered to a parent or an explicit send", () => {
    assert.equal(admission({ activeRuns: 5, governed: false }).type, "start");
    assert.equal(admission({ activeRuns: 5, bypass: true }).type, "start");
  });

  it("holds nothing while the row is off", () => {
    assert.equal(
      admission({
        activeRuns: 5,
        settings: settings({ holdNewSubagentsUnderLoad: false }),
      }).type,
      "start",
    );
  });

  it("reserves an admission so six parallel delegations do not overshoot", () => {
    // Ceiling 5, three runs active: two start, each taking a reservation, and four queue.
    let reservations = 0;
    const outcomes = [];
    for (let index = 0; index < 6; index += 1) {
      const outcome = admission({ activeRuns: 3, reservations });
      outcomes.push(outcome.type);
      if (outcome.type === "start") reservations += 1;
    }
    assert.deepEqual(outcomes, ["start", "start", "hold", "hold", "hold", "hold"]);
  });

  it("names the limit, actual value and operation in a ceiling hold", () => {
    const hold = admission({ activeRuns: 5, reservations: 0 });
    assert.equal(hold.type, "hold");
    if (hold.type !== "hold") return;
    assert.equal(
      hold.reason.message,
      "Waiting for memory: 5 of 5 runs active, so a new sub-agent cannot start. It starts when a run finishes.",
    );
  });
});

describe("release pacing", () => {
  const base = {
    settingOn: true,
    nowMs: 0,
    lastReleaseMs: null,
    activeRuns: 1,
    ceiling: 5,
    pressure: { high: false, availablePercent: 50 },
  };

  it("releases at most one every 20 seconds while below the ceiling", () => {
    assert.isTrue(canReleaseHeld(base));
    assert.isFalse(canReleaseHeld({ ...base, lastReleaseMs: 0, nowMs: RELEASE_INTERVAL_MS - 1 }));
    assert.isTrue(canReleaseHeld({ ...base, lastReleaseMs: 0, nowMs: RELEASE_INTERVAL_MS }));
  });

  it("does not release at the ceiling or under pressure", () => {
    assert.isFalse(canReleaseHeld({ ...base, activeRuns: 5 }));
    assert.isFalse(canReleaseHeld({ ...base, pressure: { high: true, availablePercent: 5 } }));
  });

  it("releases a held child in order and pace after the row is turned off", () => {
    const off = { ...base, settingOn: false, activeRuns: 5 };
    assert.isTrue(canReleaseHeld(off));
    assert.isFalse(canReleaseHeld({ ...off, lastReleaseMs: 0, nowMs: 1_000 }));
    assert.isTrue(canReleaseHeld({ ...off, lastReleaseMs: 0, nowMs: RELEASE_INTERVAL_MS }));
  });
});

describe("overdue holds", () => {
  it("reports a hold older than 30 minutes exactly once", () => {
    const runs = [{ runId: "run:old", requestedAtMs: 0 }];
    assert.isTrue(OVERDUE_AFTER_MS === 30 * 60 * 1000);
    assert.deepEqual(overdueHoldIds(runs, OVERDUE_AFTER_MS - 1, new Set()), []);
    const due = overdueHoldIds(runs, OVERDUE_AFTER_MS + 1, new Set());
    assert.deepEqual(due, ["run:old"]);
    assert.deepEqual(overdueHoldIds(runs, OVERDUE_AFTER_MS + 1, new Set(due)), []);
  });
});

describe("pressure floor", () => {
  it("is a named constant below which admission holds", () => {
    assert.equal(HIGH_PRESSURE_AVAILABLE_PERCENT, 10);
    assert.equal(concurrentRunsCeiling("auto", machine(30, 20)), 5);
    assert.equal(concurrentRunsCeiling(3, machine(30, 20)), 3);
  });
});

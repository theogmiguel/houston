// @effect-diagnostics globalDate:off - expectations are written as ISO instants.
import { describe, expect, it } from "vite-plus/test";

import { catchUpStart, runTimes } from "./window.ts";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const MINUTE = 60_000;

describe("night shift window", () => {
  it("run times for scheduled catch-up and run now starts", () => {
    const scheduled = runTimes({
      kind: "scheduled",
      startMs: at("2026-10-26T23:30:00Z"),
      wrapUp: "06:45",
      hardStop: "07:30",
      timeZone: "UTC",
    });
    expect(scheduled.ok && [iso(scheduled.wrapUpAtMs), iso(scheduled.hardStopAtMs)]).toEqual([
      "2026-10-27T06:45:00.000Z",
      "2026-10-27T07:30:00.000Z",
    ]);

    const catchUp = runTimes({
      kind: "catchUp",
      startMs: at("2026-10-27T02:10:00Z"),
      wrapUp: "06:45",
      hardStop: "07:30",
      timeZone: "UTC",
    });
    expect(catchUp.ok && [iso(catchUp.wrapUpAtMs), iso(catchUp.hardStopAtMs)]).toEqual([
      "2026-10-27T06:45:00.000Z",
      "2026-10-27T07:30:00.000Z",
    ]);

    const start = at("2026-10-27T13:00:00Z");
    const twoHours = runTimes({ kind: "runNow", startMs: start, durationMinutes: 120 });
    expect(twoHours.ok && [twoHours.wrapUpAtMs - start, twoHours.hardStopAtMs - start]).toEqual([
      75 * MINUTE,
      120 * MINUTE,
    ]);
    const forty = runTimes({ kind: "runNow", startMs: start, durationMinutes: 40 });
    expect(forty.ok && [forty.wrapUpAtMs - start, forty.hardStopAtMs - start]).toEqual([
      30 * MINUTE,
      40 * MINUTE,
    ]);
    const sixty = runTimes({ kind: "runNow", startMs: start, durationMinutes: 60 });
    expect(sixty.ok && sixty.wrapUpAtMs - start).toBe(15 * MINUTE);
    for (const durationMinutes of [15, 960]) {
      expect(runTimes({ kind: "runNow", startMs: start, durationMinutes }).ok).toBe(true);
    }
    for (const durationMinutes of [14, 961]) {
      const refused = runTimes({ kind: "runNow", startMs: start, durationMinutes });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.message).toContain("15-960");
        expect(refused.message).toContain(String(durationMinutes));
      }
    }

    const upstream = runTimes({
      kind: "upstreamRunNow",
      startMs: at("2026-10-27T14:00:00Z"),
      wrapUp: "06:45",
      hardStop: "07:30",
      timeZone: "UTC",
    });
    expect(upstream.ok).toBe(false);
    if (!upstream.ok) {
      expect(upstream.message).toContain("17 h 30 min");
      expect(upstream.message).toContain("16 h");
    }
    const upstreamNight = runTimes({
      kind: "upstreamRunNow",
      startMs: at("2026-10-27T22:00:00Z"),
      wrapUp: "06:45",
      hardStop: "07:30",
      timeZone: "UTC",
    });
    expect(upstreamNight.ok && iso(upstreamNight.hardStopAtMs)).toBe("2026-10-28T07:30:00.000Z");

    // Lisbon leaves summer time that night: 23:30 is 22:30Z, 07:30 is 07:30Z.
    const acrossDst = runTimes({
      kind: "scheduled",
      startMs: at("2026-10-24T22:30:00Z"),
      wrapUp: "06:45",
      hardStop: "07:30",
      timeZone: "Europe/Lisbon",
    });
    expect(acrossDst.ok && [iso(acrossDst.wrapUpAtMs), iso(acrossDst.hardStopAtMs)]).toEqual([
      "2026-10-25T06:45:00.000Z",
      "2026-10-25T07:30:00.000Z",
    ]);
    const summer = runTimes({
      kind: "scheduled",
      startMs: at("2026-07-11T22:30:00Z"),
      wrapUp: "06:45",
      hardStop: "07:30",
      timeZone: "Europe/Lisbon",
    });
    expect(summer.ok && [iso(summer.wrapUpAtMs), iso(summer.hardStopAtMs)]).toEqual([
      "2026-07-12T05:45:00.000Z",
      "2026-07-12T06:30:00.000Z",
    ]);
  });

  it("a missed start is caught up once before wrap-up", () => {
    // The night of the 26th is a Monday, weekday 1.
    const monday = {
      timeOfDay: "23:30",
      weekdays: [1],
      wrapUp: "06:45",
      hardStop: "07:30",
      timeZone: "UTC",
    };
    const nightStart = at("2026-10-26T23:30:00Z");
    expect(catchUpStart({ ...monday, nowMs: at("2026-10-27T02:10:00Z"), runStarts: [] })).toBe(
      nightStart,
    );
    expect(
      catchUpStart({ ...monday, nowMs: at("2026-10-27T06:50:00Z"), runStarts: [] }),
    ).toBeNull();
    // A refused run of that window is a run of that window.
    expect(
      catchUpStart({
        ...monday,
        nowMs: at("2026-10-27T02:10:00Z"),
        runStarts: [at("2026-10-26T23:30:05Z")],
      }),
    ).toBeNull();
    // A run of the previous week does not count.
    expect(
      catchUpStart({
        ...monday,
        nowMs: at("2026-10-27T02:10:00Z"),
        runStarts: [at("2026-10-19T23:30:05Z")],
      }),
    ).toBe(nightStart);
    expect(
      catchUpStart({ ...monday, weekdays: [3], nowMs: at("2026-10-27T02:10:00Z"), runStarts: [] }),
    ).toBeNull();
    expect(
      catchUpStart({ ...monday, weekdays: [], nowMs: at("2026-10-27T02:10:00Z"), runStarts: [] }),
    ).toBeNull();
    // Before the start time nothing was missed.
    expect(
      catchUpStart({ ...monday, nowMs: at("2026-10-26T23:00:00Z"), runStarts: [] }),
    ).toBeNull();
  });
});

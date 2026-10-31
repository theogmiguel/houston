// @effect-diagnostics globalDate:off - Intl reads a zone's wall clock only from a Date.
// When a run wraps up and stops, and whether a missed night is caught up, in a named time zone so
// clock times follow daylight saving.
import { HOUSTON_NIGHT_SHIFT_LIMITS as LIMITS } from "@t3tools/contracts/houston/nightShift";

import { clockMinutes, formatMinutes } from "./rules.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (timeZone: string) => {
  let found = formatters.get(timeZone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, found);
  }
  return found;
};

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const localParts = (ms: number, timeZone: string) => {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
};

/** Local time minus UTC at `ms`, whole minutes. */
const offsetAt = (ms: number, timeZone: string) => {
  const p = localParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE) * MINUTE;
};

/** The instant a local date and clock time names in `timeZone`. */
const localInstant = (date: LocalDate, minutes: number, timeZone: string) => {
  const guess = Date.UTC(date.year, date.month - 1, date.day) + minutes * MINUTE;
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
};

const localDate = (ms: number, timeZone: string): LocalDate => {
  const p = localParts(ms, timeZone);
  return { year: p.year, month: p.month, day: p.day };
};

const addDays = (date: LocalDate, days: number): LocalDate => {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
};

const weekday = (date: LocalDate) =>
  new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();

/** The first instant strictly after `afterMs` whose local clock reads `clock`. */
export const nextClock = (afterMs: number, clock: string, timeZone: string) => {
  const today = localDate(afterMs, timeZone);
  for (let offset = 0; offset <= 2; offset += 1) {
    const candidate = localInstant(addDays(today, offset), clockMinutes(clock), timeZone);
    if (candidate > afterMs) return candidate;
  }
  return afterMs + DAY;
};

export type RunTimesInput =
  | {
      readonly kind: "scheduled" | "catchUp" | "upstreamRunNow";
      readonly startMs: number;
      readonly wrapUp: string;
      readonly hardStop: string;
      readonly timeZone: string;
    }
  | { readonly kind: "runNow"; readonly startMs: number; readonly durationMinutes: number };

export type RunTimes =
  | { readonly ok: true; readonly wrapUpAtMs: number; readonly hardStopAtMs: number }
  | { readonly ok: false; readonly message: string };

/** Under an hour a run wraps up at three quarters; otherwise 45 minutes before its hard stop. */
const leadWrapUp = (startMs: number, hardStopAtMs: number) =>
  hardStopAtMs - startMs < 60 * MINUTE
    ? startMs + Math.floor(((hardStopAtMs - startMs) * 3) / 4)
    : hardStopAtMs - LIMITS.wrapUpLeadMinutes * MINUTE;

export const runTimes = (input: RunTimesInput): RunTimes => {
  if (input.kind === "runNow") {
    const minutes = input.durationMinutes;
    if (
      !Number.isInteger(minutes) ||
      minutes < LIMITS.runNowMinMinutes ||
      minutes > LIMITS.runNowMaxMinutes
    ) {
      return {
        ok: false,
        message: `a Run now lasts ${LIMITS.runNowMinMinutes}-${LIMITS.runNowMaxMinutes} minutes; got ${minutes}`,
      };
    }
    const hardStopAtMs = input.startMs + minutes * MINUTE;
    return { ok: true, wrapUpAtMs: leadWrapUp(input.startMs, hardStopAtMs), hardStopAtMs };
  }
  if (input.kind === "upstreamRunNow") {
    const hardStopAtMs = nextClock(input.startMs, input.hardStop, input.timeZone);
    const span = Math.round((hardStopAtMs - input.startMs) / MINUTE);
    if (span > LIMITS.windowMinutes) {
      return {
        ok: false,
        message: `the next hard stop ${input.hardStop} is ${formatMinutes(span)} away, over the ${formatMinutes(LIMITS.windowMinutes)} limit; use Night shift's Run now with a duration`,
      };
    }
    const wrapUpClock = nextClock(input.startMs, input.wrapUp, input.timeZone);
    return {
      ok: true,
      wrapUpAtMs:
        wrapUpClock < hardStopAtMs ? wrapUpClock : leadWrapUp(input.startMs, hardStopAtMs),
      hardStopAtMs,
    };
  }
  const wrapUpAtMs = nextClock(input.startMs, input.wrapUp, input.timeZone);
  return {
    ok: true,
    wrapUpAtMs,
    hardStopAtMs: nextClock(wrapUpAtMs, input.hardStop, input.timeZone),
  };
};

/** The missed night's start to catch up now, or null: once, and only before its wrap-up. */
export const catchUpStart = (input: {
  readonly nowMs: number;
  readonly timeOfDay: string;
  /** 0 is Sunday; empty is no night selected. */
  readonly weekdays: ReadonlyArray<number>;
  readonly wrapUp: string;
  readonly hardStop: string;
  readonly timeZone: string;
  /** Start instants of the project's runs, any trigger and phase. */
  readonly runStarts: ReadonlyArray<number>;
}): number | null => {
  if (input.weekdays.length === 0) return null;
  const today = localDate(input.nowMs, input.timeZone);
  for (let back = 0; back <= 7; back += 1) {
    const date = addDays(today, -back);
    const startMs = localInstant(date, clockMinutes(input.timeOfDay), input.timeZone);
    if (startMs > input.nowMs) continue;
    if (!input.weekdays.includes(weekday(date))) continue;
    const times = runTimes({
      kind: "catchUp",
      startMs,
      wrapUp: input.wrapUp,
      hardStop: input.hardStop,
      timeZone: input.timeZone,
    });
    if (!times.ok || input.nowMs >= times.wrapUpAtMs) return null;
    if (input.runStarts.some((ms) => ms >= startMs && ms < times.hardStopAtMs)) return null;
    return startMs;
  }
  return null;
};

/** The server's own time zone. */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

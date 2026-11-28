import type { RunStartOrigin } from "@houston-app/contracts";
import {
  MAX_CONCURRENT_RUNS,
  MIN_CONCURRENT_RUNS,
  type ConcurrentRuns,
} from "@houston-app/contracts/settings";

import type { MachineReading } from "../memory/ThreadMemory.ts";
import type { RunStartAdmission, RunStartHold } from "./RunStartGate.ts";

/** A held start waits this long before another may be released, so a burst cannot drain a queue. */
export const RELEASE_INTERVAL_MS = 20_000;
/** A hold past this age is reported to its parent once; it is a constant, not a setting. */
export const OVERDUE_AFTER_MS = 30 * 60 * 1000;
/** Below this share of available memory Houston treats the machine as under pressure. */
export const HIGH_PRESSURE_AVAILABLE_PERCENT = 10;
/** One run per 6 GB leaves headroom for the server and the commands runs start. */
const BYTES_PER_CONCURRENT_RUN = 6 * 1024 ** 3;
/** Used while Auto cannot read the machine's memory; the row names the fallback. */
export const DEFAULT_AUTO_CONCURRENT_RUNS = 5;
/** A reservation covers the short window between admission and the run row being written. */
export const RESERVATION_TTL_MS = 10_000;

export interface LoadGateSettings {
  readonly holdNewSubagentsUnderLoad: boolean;
  readonly concurrentRuns: ConcurrentRuns;
}

export interface MemoryPressure {
  readonly high: boolean;
  /** Available memory as a whole percentage, or null when the reading is unavailable. */
  readonly availablePercent: number | null;
}

export function memoryPressure(machine: MachineReading | null): MemoryPressure {
  if (machine === null || machine.totalBytes <= 0) return { high: false, availablePercent: null };
  const availablePercent = Math.max(
    0,
    Math.min(100, Math.floor((machine.availableBytes / machine.totalBytes) * 100)),
  );
  return {
    high: availablePercent < HIGH_PRESSURE_AVAILABLE_PERCENT,
    availablePercent,
  };
}

/** Auto's ceiling: one run per 6 GB, so 30 GB gets 5 and 16 GB gets 2. */
export function autoConcurrentRuns(totalBytes: number): number {
  return Math.min(
    MAX_CONCURRENT_RUNS,
    Math.max(MIN_CONCURRENT_RUNS, Math.floor(totalBytes / BYTES_PER_CONCURRENT_RUN)),
  );
}

export function concurrentRunsCeiling(
  setting: ConcurrentRuns,
  machine: MachineReading | null,
): number {
  if (setting !== "auto") return setting;
  return machine === null ? DEFAULT_AUTO_CONCURRENT_RUNS : autoConcurrentRuns(machine.totalBytes);
}

function ceilingHold(activeRuns: number, ceiling: number): RunStartHold {
  return {
    type: "hold",
    releaseAt: null,
    reason: {
      kind: "load",
      message: `Waiting for memory: ${activeRuns} of ${ceiling} runs active, so a new sub-agent cannot start. It starts when a run finishes.`,
    },
  };
}

function pressureHold(availablePercent: number): RunStartHold {
  return {
    type: "hold",
    releaseAt: null,
    reason: {
      kind: "load",
      message: `Waiting for memory: ${availablePercent}% available, below the ${HIGH_PRESSURE_AVAILABLE_PERCENT}% pressure floor, so a new sub-agent cannot start. It starts when memory frees.`,
    },
  };
}

export interface LoadAdmissionInput {
  readonly origin: RunStartOrigin;
  /** True only for new automatic work; a result or notification delivered to a parent is not. */
  readonly governed: boolean;
  /** Send now and Resume queue are the user's explicit start. */
  readonly bypass: boolean;
  readonly settings: LoadGateSettings;
  readonly machine: MachineReading | null;
  /** Runs already starting, running, or waiting on something other than the user. */
  readonly activeRuns: number;
  /** Start reservations taken since the last read, including unexpired ones. */
  readonly reservations: number;
}

/**
 * The load admission step. It holds only new automatic work while the ceiling or a high-pressure
 * reading applies; a user start and any result delivered to a parent always start.
 */
export function loadAdmission(input: LoadAdmissionInput): RunStartAdmission {
  if (input.bypass || !input.governed || input.origin !== "automatic") return { type: "start" };
  if (!input.settings.holdNewSubagentsUnderLoad) return { type: "start" };
  const pressure = memoryPressure(input.machine);
  if (pressure.high && pressure.availablePercent !== null) {
    return pressureHold(pressure.availablePercent);
  }
  const ceiling = concurrentRunsCeiling(input.settings.concurrentRuns, input.machine);
  const active = input.activeRuns + input.reservations;
  return active >= ceiling ? ceilingHold(active, ceiling) : { type: "start" };
}

export interface ReleaseDecisionInput {
  readonly settingOn: boolean;
  readonly nowMs: number;
  readonly lastReleaseMs: number | null;
  readonly activeRuns: number;
  readonly ceiling: number;
  readonly pressure: MemoryPressure;
}

/**
 * Whether the release sweep may start one held child now. It releases at most one per interval,
 * oldest first at the caller, and only while the setting is off or the machine has room.
 */
export function canReleaseHeld(input: ReleaseDecisionInput): boolean {
  if (input.lastReleaseMs !== null && input.nowMs - input.lastReleaseMs < RELEASE_INTERVAL_MS) {
    return false;
  }
  if (!input.settingOn) return true;
  if (input.pressure.high) return false;
  return input.activeRuns < input.ceiling;
}

export interface HeldAt {
  readonly runId: string;
  readonly requestedAtMs: number;
}

/** Holds older than the constant, in queue order, that have not been reported yet. */
export function overdueHoldIds(
  runs: ReadonlyArray<HeldAt>,
  nowMs: number,
  notified: ReadonlySet<string>,
): ReadonlyArray<string> {
  return runs
    .filter((run) => nowMs - run.requestedAtMs > OVERDUE_AFTER_MS && !notified.has(run.runId))
    .map((run) => run.runId);
}

/** Removes reservations older than the window in which a start row is expected to exist. */
export function liveReservations(
  reservations: ReadonlyMap<string, number>,
  nowMs: number,
): ReadonlyMap<string, number> {
  return new Map(
    [...reservations].filter(([, takenAtMs]) => nowMs - takenAtMs < RESERVATION_TTL_MS),
  );
}

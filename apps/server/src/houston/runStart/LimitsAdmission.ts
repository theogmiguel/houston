import type {
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  RunStartOrigin,
} from "@houston-app/contracts";
import type { MessageDeliveryQueueHoldReason } from "@houston-app/contracts/houston/messageDelivery";
import {
  latestRootProviderFailure,
  usageLimitBlockedRun,
} from "@houston-app/shared/orchestrationV2ThreadError";

import type { LimitWindowRecord } from "./LimitWindowRegistry.ts";
import type { RunStartHold } from "./RunStartGate.ts";

type FailureScanTurnItem =
  | Extract<OrchestrationV2TurnItem, { readonly type: "error" }>
  | { readonly type: Exclude<OrchestrationV2TurnItem["type"], "error"> };

export interface LimitsAdmissionInput {
  readonly origin: RunStartOrigin;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly turnItems: ReadonlyArray<FailureScanTurnItem>;
  /** Whether the user asked for automatic turns to wait out a limit. */
  readonly snoozeLimitedThreads: boolean;
  readonly nowMs: number;
}

export function limitsHoldReason(
  input: Pick<LimitsAdmissionInput, "providerInstanceId" | "nowMs"> & {
    readonly releaseAt: string;
    readonly overdue?: boolean;
  },
): MessageDeliveryQueueHoldReason {
  return {
    kind: "usage_limit",
    message: `Provider instance ${input.providerInstanceId} reached its usage limit (reported reset ${input.releaseAt}), so automatic starts are held until then. Send the message yourself to start it now.`,
    providerInstanceId: input.providerInstanceId,
    releaseAt: input.releaseAt,
    ...(input.overdue === true ? { overdue: true } : {}),
  };
}

/**
 * Hold automatic work on a thread whose latest run on this provider failed with a usage limit
 * whose reported reset is still ahead. A typed send and provider output are never held.
 */
export function threadUsageLimitHold(input: LimitsAdmissionInput): RunStartHold | null {
  if (input.origin !== "automatic" || !input.snoozeLimitedThreads) return null;
  const blocked = usageLimitBlockedRun(input.runs, input.turnItems, null, input.providerInstanceId);
  const failure = latestRootProviderFailure(blocked, input.turnItems);
  if (failure?.class !== "usage_limit" || failure.resetAt == null) return null;
  const resetMs = Date.parse(failure.resetAt);
  if (!Number.isFinite(resetMs) || resetMs <= input.nowMs) return null;
  return {
    type: "hold",
    releaseAt: failure.resetAt,
    reason: limitsHoldReason({
      providerInstanceId: input.providerInstanceId,
      nowMs: input.nowMs,
      releaseAt: failure.resetAt,
    }),
  };
}

/** A no-reset failure is treated as recent for this long before it stops holding. */
export const MAX_HOLD_WITHOUT_RESET_MS = 24 * 60 * 60 * 1000;
const OVERDUE_GRACE_MS = 15 * 60 * 1000;
const MAX_TEST_ATTEMPTS = 3;

export interface LimitWindowState {
  readonly active: boolean;
  readonly overdue: boolean;
  readonly releaseAt: string | null;
}

export function limitWindowState(record: LimitWindowRecord, nowMs: number): LimitWindowState {
  if (record.resetAt !== null) {
    const resetMs = Date.parse(record.resetAt);
    if (!Number.isFinite(resetMs)) return { active: false, overdue: false, releaseAt: null };
    // A timed hold ends at its reset; only a no-reset test release can outlive its release.
    return { active: resetMs > nowMs, overdue: false, releaseAt: record.resetAt };
  }
  const observedMs = Date.parse(record.observedAt);
  const recent = Number.isFinite(observedMs) && nowMs - observedMs < MAX_HOLD_WITHOUT_RESET_MS;
  const nextTestMs = record.nextTestAt === null ? null : Date.parse(record.nextTestAt);
  const overdue =
    record.testAttempt >= MAX_TEST_ATTEMPTS ||
    (nextTestMs !== null && Number.isFinite(nextTestMs) && nowMs > nextTestMs + OVERDUE_GRACE_MS);
  return { active: recent, overdue, releaseAt: null };
}

function windowApplies(record: LimitWindowRecord, model: string | null): boolean {
  return record.scope === "*" || (model !== null && record.scope === model);
}

export function accountLimitHold(input: {
  readonly origin: RunStartOrigin;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model: string | null;
  readonly windows: ReadonlyArray<LimitWindowRecord>;
  readonly holdUnlimitedThreads: boolean;
  readonly nowMs: number;
}): RunStartHold | null {
  if (input.origin !== "automatic" || !input.holdUnlimitedThreads) return null;
  const states = input.windows
    .filter((record) => windowApplies(record, input.model))
    .map((record) => ({ record, state: limitWindowState(record, input.nowMs) }))
    .filter(({ state }) => state.active);
  if (states.length === 0) return null;
  const releases = states.flatMap(({ state }) =>
    state.releaseAt === null ? [] : [state.releaseAt],
  );
  const releaseAt = releases.length === 0 ? null : releases.toSorted().at(-1)!;
  const overdue = states.some(({ state }) => state.overdue);
  const reason: MessageDeliveryQueueHoldReason = {
    kind: "usage_limit",
    message:
      releaseAt === null
        ? `Provider instance ${input.providerInstanceId} is inside a usage limit window, so automatic starts and new sub-agents are held. The provider did not report when this limit resets; Houston retries a held start.`
        : `Provider instance ${input.providerInstanceId} is inside a usage limit window that resets at ${releaseAt}, so automatic starts and new sub-agents are held until then. Send the message yourself to start it now.`,
    providerInstanceId: input.providerInstanceId,
    ...(releaseAt === null ? {} : { releaseAt }),
    ...(overdue ? { overdue: true } : {}),
  };
  return { type: "hold", releaseAt, reason };
}

export function limitsAdmission(
  input: LimitsAdmissionInput & {
    readonly model: string | null;
    readonly windows: ReadonlyArray<LimitWindowRecord>;
    readonly holdUnlimitedThreads: boolean;
  },
): RunStartHold | null {
  return (
    threadUsageLimitHold(input) ??
    accountLimitHold({
      origin: input.origin,
      providerInstanceId: input.providerInstanceId,
      model: input.model,
      windows: input.windows,
      holdUnlimitedThreads: input.holdUnlimitedThreads,
      nowMs: input.nowMs,
    })
  );
}

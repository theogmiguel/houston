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
  input: Pick<
    LimitsAdmissionInput,
    "providerInstanceId" | "nowMs"
  > & {
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
  const blocked = usageLimitBlockedRun(
    input.runs,
    input.turnItems,
    null,
    input.providerInstanceId,
  );
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

export function limitsAdmission(input: LimitsAdmissionInput): RunStartHold | null {
  return threadUsageLimitHold(input);
}

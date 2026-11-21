import * as Schema from "effect/Schema";

import type { AuthPendingApprovalNotice } from "../auth.ts";
import { AuthSessionId } from "../baseSchemas.ts";

/** A day lets the owner answer across a workday without a paired credential waiting forever. */
export const PENDING_DEVICE_APPROVAL_LIMIT_HOURS = 24;

export const HoustonAccessListPendingDevicesInput = Schema.Struct({});
export type HoustonAccessListPendingDevicesInput = typeof HoustonAccessListPendingDevicesInput.Type;

export const HoustonAccessDecidePendingDeviceInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type HoustonAccessDecidePendingDeviceInput =
  typeof HoustonAccessDecidePendingDeviceInput.Type;

export const HoustonAccessPendingDeviceDecision = Schema.Struct({
  sessionId: AuthSessionId,
  approved: Schema.Boolean,
});
export type HoustonAccessPendingDeviceDecision = typeof HoustonAccessPendingDeviceDecision.Type;

export const HoustonAccessPendingDeviceErrorReason = Schema.Literals([
  "not_found",
  "expired",
  "already_decided",
  "unavailable",
]);
export type HoustonAccessPendingDeviceErrorReason =
  typeof HoustonAccessPendingDeviceErrorReason.Type;

/** Names the device, the host setting and the limit, so a refused device knows what to fix. */
export function pendingDeviceApprovalMessage(notice: AuthPendingApprovalNotice): string {
  return `Device "${notice.deviceName}" is waiting for approval on ${notice.hostLabel}. Approve it under Settings ▸ Connections ▸ Sharing & access ▸ Require approval for new devices. If it is not approved within ${notice.limitHours} hours, it expires and must pair again.`;
}

export class HoustonAccessPendingDeviceError extends Schema.TaggedError<HoustonAccessPendingDeviceError>()(
  "HoustonAccessPendingDeviceError",
  {
    reason: HoustonAccessPendingDeviceErrorReason,
    message: Schema.String,
  },
) {}

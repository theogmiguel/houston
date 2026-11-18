import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import type { HoustonBlockingBackgroundWork } from "@houston-app/contracts/houston/backgroundWork";
import type * as Cause from "effect/Cause";

interface CommandResult {
  readonly _tag: "Success" | "Failure";
  readonly cause: Cause.Cause<unknown>;
}

/**
 * The work a refused provider switch would end, or null when the failure is something else.
 * A direct send is refused this way; the composer offers to wait for it or end it.
 */
export function blockingBackgroundWorkOf(
  result: CommandResult,
): ReadonlyArray<HoustonBlockingBackgroundWork> | null {
  if (result._tag !== "Failure") return null;
  const error = squashAtomCommandFailure(result);
  if (
    typeof error !== "object" ||
    error === null ||
    !("_tag" in error) ||
    error._tag !== "OrchestrationV2DispatchCommandError"
  ) {
    return null;
  }
  const items = "blockingBackgroundWork" in error ? error.blockingBackgroundWork : null;
  return Array.isArray(items) && items.length > 0
    ? (items as ReadonlyArray<HoustonBlockingBackgroundWork>)
    : null;
}

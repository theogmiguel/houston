import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import type * as Cause from "effect/Cause";

import type { DraftId } from "../composerDraftStore";

interface CommandResult {
  readonly _tag: "Success" | "Failure";
  readonly cause: Cause.Cause<unknown>;
}

/**
 * The draft a thread still is, or null when it reached the server. A close of a thread the
 * composer still owns and the server has no shell for closes the draft instead of settling.
 */
export function unsentDraftIdForThread(input: {
  readonly draftId: DraftId | null;
  readonly hasServerShell: boolean;
}): DraftId | null {
  return input.hasServerShell ? null : input.draftId;
}

/** A settle the server refused because the thread has no projection: the thread is already gone. */
export function isThreadNotFoundDispatchFailure(result: CommandResult): boolean {
  if (result._tag !== "Failure") return false;
  const error = squashAtomCommandFailure(result);
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "OrchestrationV2DispatchCommandError" &&
    "reason" in error &&
    error.reason === "thread_not_found"
  );
}

import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "../composerDraftStore";
import {
  blockingQueuedRunIdsOf,
  isThreadNotFoundDispatchFailure,
  unsentDraftIdForThread,
} from "./threadClose";

const draftId = DraftId.make("draft-1");

describe("unsentDraftIdForThread", () => {
  it("returns the draft while the server has no shell for the thread", () => {
    expect(unsentDraftIdForThread({ draftId, hasServerShell: false })).toBe(draftId);
  });

  it("returns null once the server knows the thread", () => {
    expect(unsentDraftIdForThread({ draftId, hasServerShell: true })).toBeNull();
  });

  it("returns null for a thread the composer does not own", () => {
    expect(unsentDraftIdForThread({ draftId: null, hasServerShell: false })).toBeNull();
  });
});

describe("isThreadNotFoundDispatchFailure", () => {
  const failure = (error: unknown) => ({
    _tag: "Failure" as const,
    cause: Cause.fail(error),
  });

  it("treats a settle refused because the thread has no projection as already closed", () => {
    expect(
      isThreadNotFoundDispatchFailure(
        failure({
          _tag: "OrchestrationV2DispatchCommandError",
          reason: "thread_not_found",
          message: "No orchestration projection exists for thread thread-1.",
        }),
      ),
    ).toBe(true);
  });

  it("keeps other dispatch failures visible", () => {
    expect(
      isThreadNotFoundDispatchFailure(
        failure({
          _tag: "OrchestrationV2DispatchCommandError",
          message: "Thread thread-1 has a queued message.",
        }),
      ),
    ).toBe(false);
  });

  it("ignores successful results", () => {
    expect(
      isThreadNotFoundDispatchFailure({
        _tag: "Success",
        cause: Cause.empty,
      }),
    ).toBe(false);
  });
});

describe("blockingQueuedRunIdsOf", () => {
  const failure = (error: unknown) => ({ _tag: "Failure" as const, cause: Cause.fail(error) });
  const refusal = { _tag: "OrchestrationV2DispatchCommandError", message: "Refused." };

  it("returns the runs the server named", () => {
    expect(
      blockingQueuedRunIdsOf(failure({ ...refusal, blockingQueuedRunIds: ["run-1", "run-2"] })),
    ).toEqual(["run-1", "run-2"]);
  });

  it("returns null for any other refusal, however its message reads", () => {
    expect(
      blockingQueuedRunIdsOf(failure({ ...refusal, message: "Thread 1 has queued run run-1." })),
    ).toBeNull();
    expect(blockingQueuedRunIdsOf(failure({ ...refusal, blockingQueuedRunIds: [] }))).toBeNull();
    expect(
      blockingQueuedRunIdsOf(failure({ _tag: "Other", blockingQueuedRunIds: ["run-1"] })),
    ).toBeNull();
    expect(blockingQueuedRunIdsOf({ _tag: "Success", cause: Cause.empty })).toBeNull();
  });
});

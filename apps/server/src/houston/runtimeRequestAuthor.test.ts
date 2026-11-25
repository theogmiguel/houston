import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2Command,
} from "@houston-app/contracts";
import * as Effect from "effect/Effect";

import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import { asyncAnswerAuthor, stampClientAnswer } from "./runtimeRequestAuthor.ts";

const answer = {
  type: "runtime-request.respond",
  commandId: CommandId.make("command:answer"),
  threadId: ThreadId.make("thread:child"),
  requestId: RuntimeRequestId.make("request:question"),
  answers: { color: "Blue" },
} satisfies OrchestrationV2Command;

describe("who answered a runtime request", () => {
  it.effect("a client's answer is the user's", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* stampClientAnswer(answer), { ...answer, answeredBy: "user" });
      const other = {
        type: "thread.user-input.dismiss",
        commandId: CommandId.make("command:dismiss"),
        threadId: answer.threadId,
        requestId: answer.requestId,
      } satisfies OrchestrationV2Command;
      assert.strictEqual(yield* stampClientAnswer(other), other);
    }),
  );

  it.effect.each([
    { field: "answeredBy", command: { ...answer, answeredBy: "agent" } },
    { field: "senderThreadId", command: { ...answer, senderThreadId: ThreadId.make("thread:x") } },
  ] as const)("a client's answer that carries $field is refused, naming it", ({ field, command }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(stampClientAnswer(command));
      assert.equal(
        userFacingDispatchErrorMessage(error),
        `runtime-request.respond cannot carry ${field}: the server records who answered.`,
      );
    }),
  );

  it("an answer sent as a message is the user's only when the user answered", () => {
    assert.deepEqual(asyncAnswerAuthor({ ...answer, answeredBy: "user" }), {
      createdBy: "user",
      creationSource: "server",
    });
    // The representation a message an agent sends with houston_thread_send has.
    assert.deepEqual(
      asyncAnswerAuthor({
        ...answer,
        answeredBy: "agent",
        senderThreadId: ThreadId.make("thread:coordinator"),
      }),
      {
        createdBy: "agent",
        creationSource: "mcp",
        senderThreadId: ThreadId.make("thread:coordinator"),
      },
    );
    for (const answeredBy of ["server", undefined] as const) {
      assert.deepEqual(asyncAnswerAuthor({ ...answer, answeredBy }), {
        createdBy: "agent",
        creationSource: "server",
      });
    }
  });
});

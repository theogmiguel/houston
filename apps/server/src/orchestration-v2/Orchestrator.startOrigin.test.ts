import { type OrchestrationV2Command } from "@houston-app/contracts";
import { assert, describe, it } from "@effect/vitest";

import { resolveRunStartOrigin, startOriginForMessage } from "./Orchestrator.ts";

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

const dispatch = (
  fields: Partial<MessageDispatch> & Pick<MessageDispatch, "createdBy" | "creationSource">,
): MessageDispatch =>
  ({
    type: "message.dispatch",
    commandId: "command:test",
    threadId: "thread:test",
    messageId: "message:test",
    text: "hello",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    ...fields,
  }) as MessageDispatch;

describe("resolveRunStartOrigin", () => {
  it("marks a composer send a user start", () => {
    assert.equal(
      resolveRunStartOrigin(dispatch({ createdBy: "user", creationSource: "web" })),
      "user",
    );
  });

  it("marks provider output already in flight a provider start", () => {
    assert.equal(
      resolveRunStartOrigin(
        dispatch({ createdBy: "agent", creationSource: "provider", notification: undefined }),
      ),
      "provider",
    );
  });

  it("marks a delegated child and a server wake automatic", () => {
    assert.equal(
      resolveRunStartOrigin(dispatch({ createdBy: "agent", creationSource: "mcp" })),
      "automatic",
    );
    assert.equal(
      resolveRunStartOrigin(dispatch({ createdBy: "agent", creationSource: "server" })),
      "automatic",
    );
  });

  it("keeps an explicit maintenance origin", () => {
    assert.equal(
      resolveRunStartOrigin(
        dispatch({ createdBy: "agent", creationSource: "server", startOrigin: "maintenance" }),
      ),
      "maintenance",
    );
  });

  it("trusts the producer's explicit origin over its actor", () => {
    assert.equal(
      resolveRunStartOrigin(
        dispatch({ createdBy: "user", creationSource: "server", startOrigin: "automatic" }),
      ),
      "automatic",
    );
  });
});

describe("startOriginForMessage", () => {
  it("reads a queued message's actor, provider source and compaction marker", () => {
    assert.equal(startOriginForMessage({ createdBy: "user", creationSource: "web" }), "user");
    assert.equal(
      startOriginForMessage({ createdBy: "agent", creationSource: "provider" }),
      "provider",
    );
    assert.equal(
      startOriginForMessage({ createdBy: "agent", creationSource: "server" }),
      "automatic",
    );
    assert.equal(
      startOriginForMessage({
        createdBy: "agent",
        creationSource: "server",
        idleCompaction: "beforeCacheExpires",
      }),
      "maintenance",
    );
  });
});

// Both tools act as the calling thread; the conversation refuses `not_slack` unless that thread
// is the open run of a Slack-filed task.
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { HoustonSlackConversation } from "../Conversation.ts";
import { HoustonSlackToolkit } from "./tools.ts";

const callerThread = (tool: string) =>
  Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
    McpInvocationContext.requireThreadScope(scope, tool),
  ).pipe(Effect.map((scope) => scope.thread.threadId as string));

export const layer = McpToolAccess.toLayer(HoustonSlackToolkit, {
  houston_slack_ask: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThread("houston_slack_ask");
      return yield* (yield* HoustonSlackConversation).ask(threadId, input);
    }),
  ),
  houston_slack_handback: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThread("houston_slack_handback");
      return yield* (yield* HoustonSlackConversation).handback(threadId, input);
    }),
  ),
});

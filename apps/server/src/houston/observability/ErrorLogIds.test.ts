import { assert, describe, it } from "@effect/vitest";
import { CommandId, MessageId, ProviderDriverKind, RunId, ThreadId } from "@houston-app/contracts";
import { derive } from "@houston-app/provider-core/server/IdAllocator";

import { isGeneratedId } from "./ErrorLogIds.ts";

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const AGENT_KEY = "acme-merger-layoffs-plan-for-alice";

// As OrchestratorMcpService builds it, around the request key an agent may choose.
const delegateCommand = (key: string) =>
  CommandId.make(`command:mcp:${UUID}:delegate-task:${encodeURIComponent(key)}`);
const delegatedThread = (key: string) =>
  derive.delegatedTaskThread({ commandId: delegateCommand(key) });

const THREAD = ThreadId.make(UUID);
const RUN = derive.run({ threadId: THREAD, ordinal: 3 });
const codex = ProviderDriverKind.make("codex");

describe("generated ids", () => {
  it.each([
    ["a thread launched by a client", UUID],
    ["a thread launched over MCP", `mcp:${UUID}`],
    ["a thread launched under a hashed key", `mcp:launch:${DIGEST}`],
    ["a fork of it", `mcp:${UUID}:fork`],
    ["a created thread", `thread:mcp:${UUID}:${OTHER}:0`],
    ["a delegated task's thread", delegatedThread(OTHER)],
    ["a delegated task's command", delegateCommand(OTHER)],
    ["a run", RUN],
    ["a delegated task's run", derive.run({ threadId: delegatedThread(OTHER), ordinal: 1 })],
    ["a run attempt", derive.runAttempt({ runId: RUN, attemptOrdinal: 1 })],
    ["a root node", derive.rootNodeAttempt({ runId: RUN, attemptOrdinal: 2 })],
    ["a message", `message:thread:${UUID}:ordinal:4:${OTHER}`],
    [
      "a delegated task's message",
      derive.delegatedTaskMessage({ commandId: delegateCommand(OTHER) }),
    ],
    ["a message's turn item", derive.userTurnItem({ messageId: MessageId.make(UUID) })],
    ["a provider thread", derive.providerThread({ driver: codex, nativeThreadId: UUID })],
    [
      "a pending provider thread",
      derive.providerThread({ driver: codex, nativeThreadId: `pending:${RUN}` }),
    ],
    ["a server command", `server:pr-sync:${UUID}:${OTHER}`],
    [
      "an effect's command",
      `effect:${delegateCommand(OTHER)}:provider-turn.start:${RUN}:unresponsive`,
    ],
    ["a launch step", `${UUID}:progress:worktree`],
    ["a task review thread", `task-review-${UUID}`],
    ["a task run thread", `task-${UUID}`],
    [
      "a task run thread's run",
      derive.run({ threadId: ThreadId.make(`task-${UUID}`), ordinal: 1 }),
    ],
    ["a remote delegation's request", `delegate:${UUID}:${OTHER}`],
    ["a forced stop", `server:force-stop:${RUN}:1731975000000`],
    ["a sent review's message", `side-${RUN}`],
    ["a checkpoint scope", `checkpoint-scope:thread:${UUID}:name:root`],
    [
      "a context handoff",
      `context-handoff:thread:${UUID}:from-provider-instance:codex:to-provider-instance:claudeAgent:${OTHER}`,
    ],
    ["a task run command", "houston-task-run:12:stop"],
    ["a merge queue thread", `merge-queue-${UUID}`],
    ["a scheduled fire", `scheduled-task:${UUID}:1731975000000:manual`],
  ])("%s is written", (_name, id) => {
    assert.isTrue(isGeneratedId(id), id);
  });

  it.each([
    ["an agent's key in a created thread", `thread:mcp:${UUID}:${AGENT_KEY}:0`],
    ["an agent's key in a command", delegateCommand(AGENT_KEY)],
    ["an agent's key in a delegated thread", delegatedThread(AGENT_KEY)],
    [
      "an agent's key in a delegated run",
      derive.run({ threadId: delegatedThread(AGENT_KEY), ordinal: 1 }),
    ],
    ["one unlisted word among listed ones", `thread:mcp:${UUID}:merger:0`],
    ["a percent-encoded word", `thread:mcp:${UUID}:%6Derger:0`],
    ["a word encoded several times", `thread:mcp:${UUID}:%25256Derger:0`],
    ["a word hidden behind an encoded separator", `thread:mcp:${UUID}%253Amerger:0`],
    ["an encoding that does not decode", `thread:mcp:${UUID}:%E0%A4%A:0`],
    ["an encoding nested past any builder", `thread:mcp:%${"25".repeat(40)}31`],
    ["a word beside a uuid", `acme-merger-${UUID}`],
    ["a listed word with an unlisted tail", `thread:run-merger:${UUID}`],
    ["a hexadecimal word", "thread:facade:decade:deadbeef"],
    ["a long word spelled in hexadecimal letters", `thread:${"deadbeef".repeat(2)}`],
    ["a listed word in another case", `THREAD:${UUID}`],
    [
      "a user-named provider instance",
      derive.providerSession({ providerInstanceId: "acme_work" as never }),
    ],
    [
      "a provider's own id",
      derive.providerThread({ driver: codex, nativeThreadId: "conv_acmeMerger" }),
    ],
    ["a pull request's URL", "houston-task-watch:3:https://example.com/acme/merger/pull/1"],
    [
      "a list of listed words past the length bound",
      Array.from({ length: 200 }, () => "thread").join(":"),
    ],
    [
      "a runtime reconcile, which carries a time",
      `command:runtime-reconcile:startup:${UUID}:2031-03-10T12:00:00.000Z`,
    ],
    [
      "a handoff to a user-named provider instance",
      `context-handoff:thread:${UUID}:from-provider-instance:codex:to-provider-instance:acme_work:${OTHER}`,
    ],
    ["an empty segment", `thread::${UUID}`],
    ["an empty value", ""],
    ["an over-long number", `thread:${"1".repeat(30)}`],
  ])("%s is not", (_name, id) => {
    assert.isFalse(isGeneratedId(id), id);
  });

  it("the ids derived by the allocator are written", () => {
    // A value stands in for each part a caller passes; what is left is the allocator's own words.
    const run = RunId.make("1");
    const command = CommandId.make("1");
    const item = { driver: codex, nativeItemId: "1" };
    for (const id of [
      derive.delegatedTaskNode({ commandId: command }),
      derive.delegatedTaskThread({ commandId: command }),
      derive.delegatedTaskMessage({ commandId: command }),
      derive.delegatedTaskTurnItem({ commandId: command }),
      derive.createdThreadTurnItem({ commandId: command }),
      derive.threadFromProviderThread({ driver: codex, nativeThreadId: "1" }),
      derive.providerSession({ providerInstanceId: "codex" as never }),
      derive.run({ threadId: ThreadId.make("1"), ordinal: 1 }),
      derive.runAttempt({ runId: run, attemptOrdinal: 1 }),
      derive.rootNode({ runId: run }),
      derive.rootNodeAttempt({ runId: run, attemptOrdinal: 1 }),
      derive.userTurnItem({ messageId: MessageId.make("1") }),
      derive.runSignalTurnItem({ runId: run, signal: "interrupt-request" }),
      derive.providerThread({ driver: codex, nativeThreadId: "1" }),
      derive.providerTurn({ driver: codex, nativeTurnId: "1" }),
      derive.nodeFromProviderItem(item),
      derive.messageFromProviderItem(item),
      derive.turnItemFromProviderItem(item),
      derive.approvalNode({ requestId: "1" as never }),
      derive.approvalTurnItem({ requestId: "1" as never }),
    ]) {
      assert.isTrue(isGeneratedId(id), id);
    }
  });
});

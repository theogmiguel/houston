import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  OrchestrationV2AppThread,
  OrchestrationV2AppThreadJson,
  OrchestrationV2Command,
  OrchestrationV2RpcSchemas,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadShellJson,
} from "../orchestrationV2.ts";
import { HoustonSideThread } from "./sideThreads.ts";

const decodeThreadJson = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson);
const encodeThreadJson = Schema.encodeSync(OrchestrationV2AppThreadJson);
const decodeThread = Schema.decodeSync(OrchestrationV2AppThread);
const decodeShellJson = Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson);
const encodeShellJson = Schema.encodeSync(OrchestrationV2ThreadShellJson);
const decodeShell = Schema.decodeSync(OrchestrationV2ThreadShell);
const decodeSide = Schema.decodeSync(HoustonSideThread);
const decodeUnknownSide = Schema.decodeUnknownSync(HoustonSideThread);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeDispatch = Schema.decodeUnknownSync(OrchestrationV2RpcSchemas.dispatchCommand.input);

const at = "2026-10-30T12:00:00.000Z";

// An app thread payload as payload_json stored it before side threads existed.
const storedThread = {
  createdBy: "user",
  creationSource: "web",
  id: "thread:source",
  projectId: "project:1",
  title: "Source",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: "thread:source", parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};

// A thread shell as subscribeShell served it before side threads existed.
const storedShell = {
  id: "thread:source",
  projectId: "project:1",
  title: "Source",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: "thread:source", parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
};

const sides = [
  { kind: "aside", sourceThreadId: "thread:source", sourceRunId: "run:source:1" },
  { kind: "secondOpinion", sourceThreadId: "thread:source", sourceRunId: "run:source:2" },
] as const;

describe("side thread records", () => {
  it("threads stored before side threads decode unchanged", () => {
    const thread = decodeThreadJson(storedThread);
    expect("side" in thread).toBe(false);
    const reencoded = encodeThreadJson(thread);
    expect("side" in reencoded).toBe(false);
    expect(reencoded).toEqual(storedThread);
    const domainThread = decodeThread(thread);
    expect("side" in domainThread).toBe(false);

    const shell = decodeShellJson(storedShell);
    expect("side" in shell).toBe(false);
    expect("side" in encodeShellJson(shell)).toBe(false);
    const domainShell = decodeShell(shell);
    expect("side" in domainShell).toBe(false);
  });

  it("both side kinds decode", () => {
    for (const side of sides) {
      const thread = decodeThreadJson({
        ...storedThread,
        id: `thread:${side.kind}`,
        side,
      });
      expect(thread.side).toEqual(side);
      expect(encodeThreadJson(thread)).toEqual({
        ...storedThread,
        id: `thread:${side.kind}`,
        side,
      });
      const shell = decodeShellJson({
        ...storedShell,
        side,
      });
      expect(shell.side).toEqual(side);
      expect(decodeSide(side)).toEqual(side);
    }
    expect(() => decodeUnknownSide({ ...sides[0], kind: "fork" })).toThrow();
  });
});

describe("side thread kinds", () => {
  it("a side thread is an aside, a second opinion or a harness review", () => {
    const review = { kind: "harnessReview", reviewId: 7 } as const;
    for (const side of [...sides, review]) {
      expect(decodeSide(side)).toEqual(side);
      const thread = decodeThreadJson({ ...storedThread, id: `thread:${side.kind}`, side });
      expect(thread.side).toEqual(side);
      expect(encodeThreadJson(thread)).toEqual({
        ...storedThread,
        id: `thread:${side.kind}`,
        side,
      });
      expect(decodeShellJson({ ...storedShell, side }).side).toEqual(side);
    }
    for (const refused of [
      { kind: "harnessReview" },
      { kind: "harnessReview", reviewId: 0 },
      { kind: "harnessReview", reviewId: 1.5 },
      { kind: "harnessReview", reviewId: "7" },
      { kind: "aside", reviewId: 7 },
      { kind: "aside", sourceRunId: "run:source:1" },
      { kind: "secondOpinion", sourceThreadId: "thread:source" },
    ]) {
      expect(() => decodeUnknownSide(refused), JSON.stringify(refused)).toThrow();
    }
  });

  it("the review start command is internal: no client can dispatch it", () => {
    const start = {
      type: "houston.harness-review.start",
      commandId: "command:review-start",
      threadId: "thread:review",
      projectId: "project:1",
      reviewId: 3,
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
      messageId: "message:review",
      text: "What this run sends",
    };
    expect(() => decodeCommand(start)).toThrow();
    expect(() => decodeDispatch(start)).toThrow();
  });
});

describe("side thread commands", () => {
  const commands = [
    {
      type: "houston.aside.start",
      createdBy: "user",
      creationSource: "web",
      commandId: "command:aside",
      sourceThreadId: "thread:source",
      asideThreadId: "thread:aside",
      messageId: "message:aside",
      text: "What does this change do?",
      attachments: [],
    },
    {
      type: "houston.second-opinion.request",
      createdBy: "user",
      creationSource: "web",
      commandId: "command:review",
      sourceThreadId: "thread:source",
      runId: "run:source:1",
      reviewThreadId: "thread:review",
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
    },
    {
      type: "houston.side-thread.send",
      commandId: "command:send",
      sideThreadId: "thread:review",
      runId: "run:review:1",
    },
  ];

  it("the houston commands are orchestration commands", () => {
    for (const command of commands) {
      expect(decodeCommand(command)).toEqual(command);
      expect(decodeDispatch(command).type).toBe(command.type);
    }
    // Each member keeps its own fields: a send without its run is not a command.
    const { runId: _runId, ...sendWithoutRun } = commands[2]!;
    expect(() => decodeCommand(sendWithoutRun)).toThrow();
    const { createdBy: _createdBy, ...asideWithoutActor } = commands[0]!;
    expect(() => decodeCommand(asideWithoutActor)).toThrow();
  });
});

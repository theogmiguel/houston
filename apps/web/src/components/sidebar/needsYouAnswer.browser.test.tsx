import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { DateTime } from "effect";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, type Screen } from "../../../test/render";
import { NeedsYouAnswerBlock } from "../ui/needs-you-answer";
import { useNeedsYouAnswer } from "./needsYouAnswer";
import type { NeedsYouEntry } from "./needsYouSection";

const state = vi.hoisted(() => ({
  children: [] as unknown[],
  details: {} as Record<string, unknown>,
  commands: [] as Array<{ command: unknown; value: unknown }>,
  result: { _tag: "Success", value: undefined } as unknown,
}));

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: { kind?: string; threadId?: string }) =>
    atom.kind === "children"
      ? state.children
      : (state.details[atom.threadId ?? ""] ?? null)) as never,
}));

vi.mock("../../state/threads", () => ({
  environmentThreadDetails: {
    threadAtom: (ref: { threadId: string }) => ({ kind: "detail", threadId: ref.threadId }),
  },
  environmentThreadShells: {
    childThreadInputsAtom: () => ({ kind: "children" }),
  },
  threadEnvironment: {
    respondToApproval: "approval",
    respondToUserInput: "input",
    startTurn: "start",
  },
}));

vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: unknown) => async (value: unknown) => {
    state.commands.push({ command, value });
    return state.result;
  },
}));

vi.mock("../../state/session", async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const createdAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

function resetState() {
  state.children = [];
  state.details = {};
  state.commands = [];
  state.result = { _tag: "Success", value: undefined };
}

function thread(id: string, overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId: "project-1",
    title: id,
    branch: "main",
    pullRequests: [],
    branchPullRequest: null,
    providerInstanceId: "claude",
    modelSelection: { instanceId: "claude", model: "sonnet" },
    runtimeMode: "execution",
    interactionMode: "default",
    snoozedUntil: null,
    settledOverride: null,
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestUserMessageAt: null,
    latestRun: null,
    runtime: null,
    autoSettleDisabledAt: null,
    lastVisitedAt: null,
    unsettledAt: null,
    lineage: {
      relationshipToParent: null,
      parentThreadId: null,
      rootThreadId: ThreadId.make(id),
      sideChat: false,
    },
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

function userInputProjection(requestId: string, question = "Which branch?") {
  return {
    environmentId,
    projection: {
      runtimeRequests: [
        {
          id: requestId,
          kind: "user_input",
          status: "pending",
          createdAt,
          responseCapability: { type: "live" },
        },
      ],
      turnItems: [
        {
          type: "user_input_request",
          requestId,
          questions: [
            {
              id: "question-1",
              header: "Branch",
              question,
              options: [
                { label: "Keep", description: "", value: "keep" },
                { label: "Drop", description: "", value: "drop" },
              ],
              multiSelect: false,
              allowCustomAnswer: true,
            },
          ],
        },
      ],
    },
  };
}

function approvalProjection(requestId: string) {
  return {
    environmentId,
    projection: {
      runtimeRequests: [
        {
          id: requestId,
          kind: "command",
          status: "pending",
          createdAt,
          responseCapability: { type: "live" },
        },
      ],
      turnItems: [{ type: "approval_request", requestId, prompt: "rm -rf build" }],
    },
  };
}

function entry(overrides: Record<string, unknown>, group: NeedsYouEntry["group"]) {
  return { thread: thread("thread-1", overrides), group } satisfies NeedsYouEntry;
}

function Harness({ value }: { value: NeedsYouEntry }) {
  const view = useNeedsYouAnswer(value);
  return view === null ? null : <NeedsYouAnswerBlock view={view} />;
}

async function withAnswer(
  value: NeedsYouEntry,
  run: (screen: Screen) => Promise<void>,
): Promise<void> {
  await using screen = await render(<Harness value={value} />);
  await run(screen);
}

describe("useNeedsYouAnswer", () => {
  it("answers the shown question with the existing user-input command", async () => {
    resetState();
    state.details["thread-1"] = userInputProjection("request-1");
    await withAnswer(entry({ hasPendingUserInput: true }, "input"), async (screen) => {
      await userEvent.click(screen.getByRole("button", { name: "Keep" }));
      await vi.waitFor(() =>
        expect(state.commands).toEqual([
          {
            command: "input",
            value: {
              environmentId,
              input: { threadId, requestId: "request-1", answers: { "question-1": "keep" } },
            },
          },
        ]),
      );
    });
  });

  it("answers free text from the inline reply field", async () => {
    resetState();
    state.details["thread-1"] = userInputProjection("request-reply");
    await withAnswer(entry({ hasPendingUserInput: true }, "input"), async (screen) => {
      await userEvent.click(screen.getByRole("button", { name: "Reply…" }));
      await userEvent.type(screen.getByRole("textbox", { name: "Reply…" }), "release{Enter}");
      await vi.waitFor(() =>
        expect(state.commands).toEqual([
          {
            command: "input",
            value: {
              environmentId,
              input: {
                threadId,
                requestId: "request-reply",
                answers: { "question-1": "release" },
              },
            },
          },
        ]),
      );
    });
  });

  it("answers a sub-agent's question on the child thread", async () => {
    resetState();
    state.children = [
      thread("child-1", {
        hasPendingUserInput: true,
        pendingSubagentRequest: "user_input",
      }),
    ];
    state.details["child-1"] = userInputProjection("request-child");
    await withAnswer(entry({ pendingSubagentRequest: "user_input" }, "input"), async (screen) => {
      await userEvent.click(screen.getByRole("button", { name: "Drop" }));
      await vi.waitFor(() =>
        expect(state.commands).toEqual([
          {
            command: "input",
            value: {
              environmentId,
              input: {
                threadId: ThreadId.make("child-1"),
                requestId: "request-child",
                answers: { "question-1": "drop" },
              },
            },
          },
        ]),
      );
    });
  });

  it("approves and denies with the existing approval command", async () => {
    resetState();
    state.details["thread-1"] = approvalProjection("request-2");
    await withAnswer(entry({ hasPendingApprovals: true }, "approval"), async (screen) => {
      await expect.element(screen.getByText("rm -rf build")).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "Deny" }));
      await vi.waitFor(() =>
        expect(state.commands).toEqual([
          {
            command: "approval",
            value: {
              environmentId,
              input: { threadId, requestId: "request-2", decision: "decline" },
            },
          },
        ]),
      );
    });
  });

  it("retries a resumable failure with a manual continuation", async () => {
    resetState();
    state.details["thread-1"] = {
      environmentId,
      projection: {
        runs: [{ id: "run-1", status: "interrupted", userMessageId: "message-1" }],
        messages: [],
        turnItems: [],
        runtimeRequests: [],
      },
    };
    await withAnswer(
      entry(
        {
          runtime: { status: "failed", lastError: "The run stopped." },
          latestRun: { runId: "run-1", status: "interrupted" },
        },
        "failed",
      ),
      async (screen) => {
        await expect.element(screen.getByText("The run stopped.")).toBeVisible();
        await userEvent.click(screen.getByRole("button", { name: "Retry" }));
        await vi.waitFor(() =>
          expect(state.commands).toEqual([
            {
              command: "start",
              value: {
                environmentId,
                input: expect.objectContaining({
                  threadId,
                  manualContinuationOfRunId: "run-1",
                  dispatchMode: "start",
                  message: expect.objectContaining({ text: "Continue where you left off." }),
                }),
              },
            },
          ]),
        );
      },
    );
  });

  it("shows a bounded error when another window already answered", async () => {
    resetState();
    state.result = {
      _tag: "Failure",
      cause: Cause.fail(new Error("This thread can no longer be resumed from that run.")),
    };
    state.details["thread-1"] = userInputProjection("request-3");
    await withAnswer(entry({ hasPendingUserInput: true }, "input"), async (screen) => {
      await userEvent.click(screen.getByRole("button", { name: "Keep" }));
      await expect
        .element(screen.getByRole("alert"))
        .toHaveTextContent("This thread can no longer be resumed from that run.");
    });
  });
});

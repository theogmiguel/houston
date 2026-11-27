import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@houston-app/contracts";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { PendingUserInputDraftAnswer } from "@houston-app/client-runtime/state/pending-user-input";
import {
  buildPendingUserInputAnswers,
  normalizeSelectedOptionValues,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "@houston-app/client-runtime/state/pending-user-input";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@houston-app/client-runtime/state/runtime";
import { deriveResumableRunId } from "@houston-app/client-runtime/state/thread-execution";
import {
  derivePendingThreadRequests,
  seedUserInputDraftAnswers,
  type ThreadPendingApproval,
  type ThreadPendingUserInput,
} from "@houston-app/client-runtime/state/thread-requests";
import { useRef, useState } from "react";

import { newMessageId } from "../../lib/utils";
import { readEnvironmentScope } from "../../state/session";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import {
  boundNeedsYouText,
  needsYouFailureReason,
  type NeedsYouAnswerQuestion,
  type NeedsYouAnswerView,
} from "../ui/needs-you-answer-model";
import type { NeedsYouEntry } from "./needsYouSection";

/** The continuation text Resume sends, reused so an in-place retry reads the same. */
const CONTINUATION_TEXT = "Continue where you left off.";

const ANSWER_FAILED = "Could not answer this request.";
const RETRY_FAILED = "Could not retry this thread.";

type DraftsByRequest = Record<string, Record<string, PendingUserInputDraftAnswer>>;
type IndexByRequest = Record<string, number>;
type Failure = { readonly requestId: string; readonly message: string };

function environmentThreadRef(environmentId: EnvironmentId, threadId: ThreadId) {
  return scopeThreadRef(environmentId, threadId);
}

function readFailure<A, E>(result: AtomCommandResult<A, E>, fallback: string): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const failure = squashAtomCommandFailure(result);
  return boundNeedsYouText(failure instanceof Error ? failure.message : fallback);
}

function questionView(
  question: ThreadPendingUserInput["questions"][number],
): NeedsYouAnswerQuestion {
  return {
    id: question.id,
    text: boundNeedsYouText(question.question),
    header: question.header === undefined ? null : boundNeedsYouText(question.header),
    options: question.options.map((option) => ({
      label: boundNeedsYouText(option.label),
      value: option.value ?? option.label,
    })),
    multiSelect: question.multiSelect,
    allowCustomAnswer: question.allowCustomAnswer !== false,
  };
}

function approvalCommand(approval: ThreadPendingApproval): string {
  return boundNeedsYouText(
    approval.detail?.trim() || approval.reason?.trim() || approval.requestKind,
  );
}

/**
 * The question, approval or failure an open "Needs you" row answers, with the
 * actions the composer uses for the same request. It subscribes to one thread's
 * detail stream at a time: the row's own thread, or the child that asked.
 */
export function useNeedsYouAnswer(entry: NeedsYouEntry): NeedsYouAnswerView | null {
  const thread = entry.thread;
  const environmentId = thread.environmentId;
  const parentRef = environmentThreadRef(environmentId, thread.id);
  const childInputs = useAtomValue(environmentThreadShells.childThreadInputsAtom(parentRef));
  const expected =
    entry.group === "approval" ? "approval" : entry.group === "input" ? "input" : null;
  const ownExpected =
    expected === "approval"
      ? thread.hasPendingApprovals
      : expected === "input"
        ? thread.hasPendingUserInput
        : false;
  const subagentPending =
    expected !== null && !ownExpected && thread.pendingSubagentRequest != null;
  const child =
    subagentPending && expected !== null
      ? (childInputs.find((candidate) =>
          expected === "approval" ? candidate.hasPendingApprovals : candidate.hasPendingUserInput,
        ) ?? null)
      : null;
  const targetRef =
    child === null ? parentRef : environmentThreadRef(child.environmentId, child.id);
  const target = child === null ? thread : child;
  const detail = useAtomValue(environmentThreadDetails.threadAtom(targetRef));

  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });

  const [draftsByRequest, setDraftsByRequest] = useState<DraftsByRequest>({});
  const [indexByRequest, setIndexByRequest] = useState<IndexByRequest>({});
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const inFlight = useRef(false);

  const requests =
    entry.group === "failed" || detail === null
      ? null
      : derivePendingThreadRequests(detail.projection);
  const userInput = requests?.userInputs[0] ?? null;
  const approval = requests?.approvals[0] ?? null;
  const requestId = userInput?.requestId ?? approval?.requestId ?? "failed";
  const error = failure !== null && failure.requestId === requestId ? failure.message : null;

  const markPending = (next: boolean) => {
    inFlight.current = next;
    setPending(next);
  };
  const fail = (request: string, message: string) => setFailure({ requestId: request, message });

  const submitUserInput = async (
    request: ThreadPendingUserInput,
    answers: Record<string, unknown>,
  ) => {
    if (!readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)) return;
    if (inFlight.current) return;
    markPending(true);
    setFailure(null);
    const result = await respondToUserInput({
      environmentId: target.environmentId,
      input: { threadId: target.id, requestId: request.requestId, answers },
    });
    markPending(false);
    const message = readFailure(result, ANSWER_FAILED);
    if (message !== null) fail(request.requestId, message);
  };

  const respondToApprovalDecision = async (
    request: ThreadPendingApproval,
    decision: "accept" | "decline",
  ) => {
    if (!readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)) return;
    if (inFlight.current) return;
    markPending(true);
    setFailure(null);
    const result = await respondToApproval({
      environmentId: target.environmentId,
      input: { threadId: target.id, requestId: request.requestId, decision },
    });
    markPending(false);
    const message = readFailure(result, ANSWER_FAILED);
    if (message !== null) fail(request.requestId, message);
  };

  const retry = async () => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    if (inFlight.current) return;
    markPending(true);
    setFailure(null);
    const projection = detail?.projection ?? null;
    const retryRunId =
      projection === null ? null : deriveResumableRunId(projection, thread.runtime);
    const result = await startTurn({
      environmentId,
      input: {
        threadId: thread.id,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: CONTINUATION_TEXT,
          attachments: [],
        },
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        ...(retryRunId === null
          ? {}
          : { manualContinuationOfRunId: retryRunId, dispatchMode: "start" as const }),
      },
    });
    markPending(false);
    const message = readFailure(result, RETRY_FAILED);
    if (message !== null) fail("failed", message);
  };

  if (entry.group === "back") return null;
  if (entry.group === "failed") {
    return {
      kind: "failed",
      reason: needsYouFailureReason(thread),
      pending,
      error,
      onRetry: () => void retry(),
    };
  }
  if (subagentPending && child === null) return { kind: "loading" };
  if (requests === null) return { kind: "loading" };

  if (userInput !== null) {
    const questions = userInput.questions;
    const requestDrafts = draftsByRequest[userInput.requestId] ?? {};
    const seeded: Record<string, PendingUserInputDraftAnswer> = seedUserInputDraftAnswers(
      questions,
      requestDrafts,
    );
    const index = Math.min(
      Math.max(indexByRequest[userInput.requestId] ?? 0, 0),
      Math.max(questions.length - 1, 0),
    );
    const question = questions[index];
    if (question === undefined) return null;
    const view = questionView(question);

    const advance = (drafts: Record<string, PendingUserInputDraftAnswer>) => {
      setDraftsByRequest((existing) => ({
        ...existing,
        [userInput.requestId]: drafts,
      }));
      const answer = resolvePendingUserInputAnswer(question, drafts[question.id]);
      if (answer === null) return;
      if (index < questions.length - 1) {
        setIndexByRequest((existing) => ({ ...existing, [userInput.requestId]: index + 1 }));
        return;
      }
      const answers = buildPendingUserInputAnswers(questions, drafts);
      if (answers !== null) void submitUserInput(userInput, answers);
    };

    const toggleOption = (value: string) => {
      if (pending) return;
      const next = {
        ...seeded,
        [question.id]: togglePendingUserInputOptionSelection(question, seeded[question.id], value),
      };
      setDraftsByRequest((existing) => ({
        ...existing,
        [userInput.requestId]: next,
      }));
      setFailure(null);
      if (!question.multiSelect) advance(next);
    };

    const submit = () => {
      if (pending) return;
      setFailure(null);
      advance({ ...seeded });
    };

    const reply = (text: string) => {
      if (pending || !view.allowCustomAnswer) return;
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      const next = {
        ...seeded,
        [question.id]: setPendingUserInputCustomAnswer(question, seeded[question.id], trimmed),
      };
      setFailure(null);
      advance(next);
    };

    return {
      kind: "input",
      requestId: userInput.requestId,
      question: view,
      progress: { index, total: questions.length },
      selectedValues: normalizeSelectedOptionValues(
        question,
        seeded[question.id]?.selectedOptionValues,
      ),
      pending,
      error,
      onToggleOption: toggleOption,
      onSubmit: submit,
      onReply: reply,
    };
  }

  if (approval !== null) {
    return {
      kind: "approval",
      requestId: approval.requestId,
      command: approvalCommand(approval),
      pending,
      error,
      canRespond: approval.responseCapability === "live",
      onApprove: () => void respondToApprovalDecision(approval, "accept"),
      onDeny: () => void respondToApprovalDecision(approval, "decline"),
    };
  }

  return null;
}

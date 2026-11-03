import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@houston-app/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@houston-app/contracts";
import type {
  HoustonMergeQueueEntry,
  HoustonMergeQueueGate,
} from "@houston-app/contracts/houston/mergeQueue";
import {
  ArrowRightIcon,
  CircleCheckIcon,
  CircleIcon,
  CircleXIcon,
  ClockIcon,
  RotateCcwIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { mergeQueueEnvironment, useMergeQueueEntry } from "~/state/mergeQueue";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  MERGE_QUEUE_BRANCH,
  MERGE_QUEUE_FAILURE_FILES,
  MERGE_QUEUE_FAILURE_NOTE,
  MERGE_QUEUE_FAILURE_TITLE,
  MERGE_QUEUE_GATE_LABEL,
  MERGE_QUEUE_GATE_LIST,
  MERGE_QUEUE_GATE_REASON,
  MERGE_QUEUE_GATE_ROW,
  MERGE_QUEUE_META_LINE,
  MERGE_QUEUE_NOTE,
  MERGE_QUEUE_OUTPUT,
  MERGE_QUEUE_SCROLL,
  MERGE_QUEUE_SECTION_TITLE,
  MERGE_QUEUE_UNIT,
  mergeQueueGateIconClass,
} from "../ui/merge-queue-recipes";
import { MergeQueueHandToThreadDialog } from "./MergeQueueHandToThreadDialog";
import { PullRequestGlyph } from "./pullRequestIcons";
import {
  mergeQueueEntryActions,
  mergeQueueFailureNote,
  mergeQueueFailureTitle,
  mergeQueueGateLabel,
  mergeQueueGateReason,
  mergeQueueGateTone,
  mergeQueueStatusLabel,
  mergeQueueVerificationLine,
  shortMergeQueueSha,
} from "./mergeQueue.logic";

const GATE_ICON = {
  ok: CircleCheckIcon,
  warn: ClockIcon,
  error: CircleXIcon,
  info: CircleIcon,
  neutral: CircleIcon,
} as const;

function GateRow({ gate }: { gate: HoustonMergeQueueGate }) {
  const Icon = GATE_ICON[mergeQueueGateTone(gate)];
  const reason = mergeQueueGateReason(gate);
  return (
    <li className={MERGE_QUEUE_GATE_ROW}>
      <Icon
        aria-hidden
        className={`size-4 shrink-0 ${mergeQueueGateIconClass(mergeQueueGateTone(gate))}`}
      />
      <span className={MERGE_QUEUE_GATE_LABEL}>{mergeQueueGateLabel(gate)}</span>
      {reason === "" ? null : <span className={MERGE_QUEUE_GATE_REASON}>{reason}</span>}
    </li>
  );
}

function FailureAlert({ entry }: { entry: HoustonMergeQueueEntry }) {
  const failure = entry.failure;
  if (failure === null) return null;
  const title = mergeQueueFailureTitle(failure);
  return (
    <Alert variant="error" controlAlignment="first-line" className="flex-col">
      <AlertDescription>
        <span className={MERGE_QUEUE_FAILURE_TITLE}>{title}</span>
        {failure.message.trim() === "" || failure.message === title ? null : (
          <span className={MERGE_QUEUE_FAILURE_NOTE}>{failure.message}</span>
        )}
        {failure.files.length === 0 ? null : (
          <ul className={MERGE_QUEUE_FAILURE_FILES}>
            {failure.files.map((file) => (
              <li key={file} className="truncate">
                {file}
              </li>
            ))}
          </ul>
        )}
        {failure.outputTail === null ? null : (
          <pre className={MERGE_QUEUE_OUTPUT}>{failure.outputTail}</pre>
        )}
        <span className={MERGE_QUEUE_FAILURE_NOTE}>{mergeQueueFailureNote(failure)}</span>
      </AlertDescription>
    </Alert>
  );
}

type CommandResult = AtomCommandResult<unknown, unknown>;

function usePanelClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- ticks the elapsed clock while a verification is running
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

function readableFailure(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The merge queue refused it. Try again.";
}

export function MergeQueueEntryPanel({
  environmentId,
  projectId,
  number,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  number: number;
}) {
  const { snapshot, entry, error } = useMergeQueueEntry(environmentId, projectId, number);
  const mergeHead = useAtomCommand(mergeQueueEnvironment.mergeHead, { reportFailure: false });
  const retry = useAtomCommand(mergeQueueEnvironment.retry, { reportFailure: false });
  const dequeue = useAtomCommand(mergeQueueEnvironment.dequeue, { reportFailure: false });
  const revert = useAtomCommand(mergeQueueEnvironment.revert, { reportFailure: false });
  const [pending, setPending] = useState<string | null>(null);
  const [handOpen, setHandOpen] = useState(false);
  const now = usePanelClock(entry?.status === "verifying");

  const report = (title: string, result: Extract<CommandResult, { _tag: "Failure" }>) => {
    if (isAtomCommandInterrupted(result)) return;
    toastManager.add({ type: "error", title, description: readableFailure(result) });
  };

  if (entry === null) {
    return (
      <div className={MERGE_QUEUE_SCROLL}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-9 py-6">
          <Alert variant={error === null ? "info" : "error"}>
            <AlertDescription>
              {error ??
                `#${number} is not in the merge queue. Add it from this pull request's menu.`}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  const actions = mergeQueueEntryActions(entry, snapshot ?? { log: [] });
  const verification = mergeQueueVerificationLine(entry);
  const mergeHeadDisabled = !actions.canMergeHead || pending !== null;

  const finish = (label: string, result: CommandResult, success: () => string) => {
    if (result._tag === "Failure") {
      report(`${label} failed`, result);
      return;
    }
    const value = result.value as { readonly message?: string } | null | undefined;
    toastManager.add({ type: "success", title: value?.message ?? success() });
  };

  return (
    <div className={MERGE_QUEUE_SCROLL}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-9 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className={MERGE_QUEUE_META_LINE}>
            <PullRequestGlyph.pullRequest aria-hidden className="size-3.5" />
            {entry.baseRef === null ? "main" : entry.baseRef}
            <ArrowRightIcon aria-hidden className="size-3" />
            <span className={MERGE_QUEUE_BRANCH}>{entry.headRef}</span>
            <span className={MERGE_QUEUE_BRANCH}>{shortMergeQueueSha(entry.headSha)}</span>
          </span>
          <span className="min-w-0 flex-1" />
          <span className={MERGE_QUEUE_UNIT}>
            {mergeQueueStatusLabel(entry, snapshot?.settings ?? null, now)}
          </span>
        </div>

        <FailureAlert entry={entry} />

        <section className="flex flex-col gap-2">
          <h2 className={MERGE_QUEUE_SECTION_TITLE}>Gates</h2>
          {entry.gates.length === 0 ? (
            <p className={MERGE_QUEUE_NOTE}>The queue has not read the gates yet.</p>
          ) : (
            <ul className={MERGE_QUEUE_GATE_LIST}>
              {entry.gates.map((gate) => (
                <GateRow key={gate.kind} gate={gate} />
              ))}
            </ul>
          )}
          {verification === null ? null : <p className={MERGE_QUEUE_NOTE}>{verification}</p>}
        </section>

        <div className="flex flex-wrap items-center gap-2">
          {actions.canMergeHead ? (
            <Button
              disabled={mergeHeadDisabled}
              title={`Merges exactly ${entry.headSha}`}
              onClick={() => {
                setPending("Merge head");
                void mergeHead({
                  environmentId,
                  input: { projectId, number, expectedHeadSha: entry.headSha },
                }).then((result) => {
                  setPending(null);
                  finish(
                    "Merge head",
                    result,
                    () => `Merging #${number} at ${shortMergeQueueSha(entry.headSha)}`,
                  );
                });
              }}
            >
              <PullRequestGlyph.merged />
              Merge head
            </Button>
          ) : null}
          {actions.canRetry ? (
            <Button
              variant="outline"
              disabled={pending !== null}
              onClick={() => {
                setPending("Retry");
                void retry({ environmentId, input: { projectId, number } }).then((result) => {
                  setPending(null);
                  finish("Retry", result, () => `#${number} is back in line`);
                });
              }}
            >
              <RotateCcwIcon />
              Retry
            </Button>
          ) : null}
          {actions.canHandToThread ? (
            <Button variant="outline" disabled={pending !== null} onClick={() => setHandOpen(true)}>
              <WrenchIcon />
              Hand to a new thread
            </Button>
          ) : null}
          {actions.canRevert ? (
            <Button
              variant="outline"
              disabled={pending !== null}
              onClick={() => {
                setPending("Revert");
                void revert({ environmentId, input: { projectId, number } }).then((result) => {
                  setPending(null);
                  finish(
                    "Revert",
                    result,
                    () => `GitHub opened a revert pull request for #${number}`,
                  );
                });
              }}
            >
              Revert
            </Button>
          ) : null}
          <Button
            variant="ghost"
            disabled={pending !== null}
            onClick={() => {
              setPending("Dequeue");
              void dequeue({ environmentId, input: { projectId, number } }).then((result) => {
                setPending(null);
                finish("Dequeue", result, () => `#${number} left the merge queue`);
              });
            }}
          >
            Dequeue
          </Button>
        </div>

        <p className={MERGE_QUEUE_NOTE}>
          Dequeue takes it out of the line and takes back what GitHub holds for it.
        </p>
      </div>

      <MergeQueueHandToThreadDialog
        open={handOpen}
        onOpenChange={setHandOpen}
        environmentId={environmentId}
        projectId={projectId}
        number={number}
      />
    </div>
  );
}

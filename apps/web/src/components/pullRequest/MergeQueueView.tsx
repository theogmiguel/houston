import type { EnvironmentId, ProjectId } from "@houston-app/contracts";
import type {
  HoustonMergeQueueEntry,
  HoustonMergeQueueLogEntry,
} from "@houston-app/contracts/houston/mergeQueue";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@houston-app/client-runtime/state/runtime";
import { CircleAlertIcon, InfoIcon, PauseIcon, PlayIcon, SettingsIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { mergeQueueEnvironment, useMergeQueueSnapshot } from "~/state/mergeQueue";

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";
import { MERGE_QUEUE_PAGE_NOTE, MERGE_QUEUE_POLICY } from "../ui/merge-queue-recipes";
import { MergeQueueList } from "./MergeQueueList";
import { mergeQueueAwayNotice, mergeQueuePolicyLine } from "./mergeQueue.logic";

type CommandFailure = Extract<AtomCommandResult<unknown, unknown>, { _tag: "Failure" }>;

function readableFailure(result: CommandFailure): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The merge queue refused it. Try again.";
}

function useQueueClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- ticks the elapsed clock while a verification is running
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

export function MergeQueueView({
  environmentId,
  projectId,
  selectedKey,
  projectControl,
  onSelectEntry,
  onSelectLog,
  onOpenSettings,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  selectedKey: string | null;
  projectControl: ReactNode;
  onSelectEntry: (entry: HoustonMergeQueueEntry) => void;
  onSelectLog: (row: HoustonMergeQueueLogEntry) => void;
  onOpenSettings: () => void;
}) {
  const { snapshot, error, isPending, refresh } = useMergeQueueSnapshot(environmentId, projectId);
  const pause = useAtomCommand(mergeQueueEnvironment.pause, { reportFailure: false });
  const acknowledge = useAtomCommand(mergeQueueEnvironment.acknowledge, { reportFailure: false });
  const revert = useAtomCommand(mergeQueueEnvironment.revert, { reportFailure: false });
  const [revertingNumber, setRevertingNumber] = useState<number | null>(null);
  const [pendingPause, setPendingPause] = useState(false);
  const [pendingAcknowledge, setPendingAcknowledge] = useState(false);
  const now = useQueueClock(
    snapshot?.entries.some((entry) => entry.status === "verifying") === true,
  );

  const report = (title: string, result: CommandFailure) => {
    if (isAtomCommandInterrupted(result)) return;
    toastManager.add({ type: "error", title, description: readableFailure(result) });
  };

  const togglePause = async () => {
    if (snapshot === null) return;
    setPendingPause(true);
    const result = await pause({
      environmentId,
      input: { projectId, paused: !snapshot.settings.paused },
    });
    setPendingPause(false);
    if (result._tag === "Failure") {
      report("Could not change the merge queue pause", result);
      return;
    }
    toastManager.add({ type: "success", title: result.value.message });
  };

  const acknowledgeAway = async () => {
    setPendingAcknowledge(true);
    const result = await acknowledge({ environmentId, input: { projectId } });
    setPendingAcknowledge(false);
    if (result._tag === "Failure") report("Could not acknowledge the merge queue", result);
  };

  const revertMerged = async (number: number) => {
    setRevertingNumber(number);
    const result = await revert({ environmentId, input: { projectId, number } });
    setRevertingNumber(null);
    if (result._tag === "Failure") {
      report(`Could not open a revert for #${number}`, result);
      return;
    }
    toastManager.add({ type: "success", title: result.value.message });
  };

  if (error !== null && snapshot === null) {
    return (
      <Alert variant="error">
        <AlertAction>
          <Button size="sm" variant="outline" disabled={isPending} onClick={refresh}>
            Retry
          </Button>
        </AlertAction>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (snapshot === null) {
    return (
      <p className={MERGE_QUEUE_PAGE_NOTE} role="status">
        Loading the merge queue…
      </p>
    );
  }

  const away = mergeQueueAwayNotice(snapshot.away);
  const paused = snapshot.settings.paused || snapshot.globalPaused;
  const empty =
    snapshot.entries.length === 0 && snapshot.log.filter((row) => row.kind !== "push").length === 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {projectControl}
        <span className="min-w-0 flex-1" />
        <Button
          size="sm"
          variant="outline"
          disabled={pendingPause || snapshot.globalPaused}
          title={
            snapshot.globalPaused
              ? "Every merge queue on this machine is paused. Resume them in Settings."
              : undefined
          }
          onClick={() => void togglePause()}
        >
          {snapshot.settings.paused ? <PlayIcon /> : <PauseIcon />}
          {snapshot.settings.paused ? "Resume" : "Pause"}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Merge queue settings"
          onClick={onOpenSettings}
        >
          <SettingsIcon className="size-4" />
        </Button>
      </div>

      {snapshot.globalPaused ? (
        <Alert variant="warning">
          <CircleAlertIcon aria-hidden />
          <AlertDescription>Every merge queue on this machine is paused.</AlertDescription>
        </Alert>
      ) : paused ? (
        <Alert variant="info">
          <InfoIcon aria-hidden />
          <AlertDescription>
            {snapshot.message ?? "Paused: nothing is pushed or merged until you resume."}
          </AlertDescription>
        </Alert>
      ) : null}

      {snapshot.message !== null && !paused ? (
        <Alert variant="warning">
          <CircleAlertIcon aria-hidden />
          <AlertDescription>{snapshot.message}</AlertDescription>
        </Alert>
      ) : null}

      {away === null ? null : (
        <Alert variant="info">
          <AlertAction>
            <Button
              size="xs"
              variant="outline"
              disabled={pendingAcknowledge}
              onClick={() => void acknowledgeAway()}
            >
              Acknowledge
            </Button>
          </AlertAction>
          <AlertDescription>{away}</AlertDescription>
        </Alert>
      )}

      <p className={MERGE_QUEUE_POLICY}>
        {mergeQueuePolicyLine(snapshot.settings, snapshot.handOff)}
      </p>

      {empty ? (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>The merge queue is empty</EmptyTitle>
            <EmptyDescription>
              Pull requests added to the merge queue appear here in the order they merge.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <MergeQueueList
          snapshot={snapshot}
          now={now}
          selectedKey={selectedKey}
          onSelectEntry={onSelectEntry}
          onSelectLog={onSelectLog}
          onRevert={(number) => void revertMerged(number)}
          revertingNumber={revertingNumber}
        />
      )}
    </div>
  );
}

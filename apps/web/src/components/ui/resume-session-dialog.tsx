import { type EnvironmentId, type ProjectId, ProviderDriverKind } from "@houston-app/contracts";
import type { HoustonResumeSession } from "@houston-app/contracts/houston/resumeSessions";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { houstonOpenResumeSession, houstonResumeSessions } from "~/state/resumeSessions";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  planResumeSelection,
  RESUME_PROVIDER_LABELS,
  resumeSessionKey,
  resumeSessionLocation,
  resumeSessionRows,
  resumeSessionStatusLabel,
  resumeSessionTitle,
} from "../chat/resumeSession.logic";
import { useThreadOpen } from "../grid/threadOpenContext";
import { Button } from "./button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./dialog";
import { Spinner } from "./spinner";
import { toastManager } from "./toast";

function resumeFailureMessage(failure: unknown): string {
  const error = squashAtomCommandFailure(failure as never);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The session could not be opened.";
}

export function ResumeSessionDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly projectWorkspaceRoot: string | null;
}) {
  const { environmentId, projectId, projectWorkspaceRoot, open } = props;
  const openThread = useThreadOpen();
  const sessions = useEnvironmentQuery(
    open && projectId !== null
      ? houstonResumeSessions({ environmentId, input: { projectId } })
      : null,
  );
  const openSession = useAtomCommand(houstonOpenResumeSession, { reportFailure: false });
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const rows = resumeSessionRows(sessions.data?.sessions ?? []);

  const choose = async (session: HoustonResumeSession) => {
    const plan = planResumeSelection(session);
    if (plan.action === "open") {
      props.onOpenChange(false);
      openThread(scopeThreadRef(environmentId, plan.threadId));
      return;
    }
    if (plan.action === "confirm") {
      const confirmed = await requestConfirmDialog(
        `${resumeSessionTitle(session)} was active ${formatRelativeTimeLabel(session.lastActiveAt)}. If it is still open in another Claude Code or Codex CLI, resuming it here can conflict. Open it anyway?`,
      );
      if (confirmed !== true) return;
    }
    if (projectId === null) return;
    setBusyKey(resumeSessionKey(session));
    const result = await openSession({
      environmentId,
      input: { projectId, session: session.session },
    });
    setBusyKey(null);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      toastManager.add({
        type: "error",
        title: "Could not open the session",
        description: resumeFailureMessage(result),
      });
      sessions.refresh();
      return;
    }
    props.onOpenChange(false);
    openThread(scopeThreadRef(environmentId, result.value.threadId));
  };

  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Resume a session</DialogTitle>
          <DialogDescription>
            Earlier Claude Code and Codex sessions for this project and its worktrees, newest first.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="min-h-0">
          {projectId === null || projectWorkspaceRoot === null ? (
            <p className="py-6 text-sm text-muted-foreground">
              Select a project before resuming a session.
            </p>
          ) : sessions.isPending && sessions.data === null ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner size="md" />
              Looking for sessions…
            </div>
          ) : sessions.error !== null ? (
            <div role="alert" className="flex items-center justify-between gap-3 py-4 text-sm">
              <span className="text-muted-foreground">
                Could not list sessions. {sessions.error}
              </span>
              <Button variant="ghost" size="sm" onClick={sessions.refresh}>
                Retry
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              No Claude Code or Codex sessions found for this project yet.
            </p>
          ) : (
            <div className="max-h-96 overflow-y-auto pe-1">
              <div className="flex flex-col gap-0.5">
                {rows.map((session) => {
                  const key = resumeSessionKey(session);
                  const status = resumeSessionStatusLabel(session);
                  const age = formatRelativeTimeLabel(session.lastActiveAt);
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={busyKey !== null}
                      onClick={() => void choose(session)}
                      className="flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left hover:bg-muted/60 disabled:opacity-60"
                    >
                      <ProviderInstanceIcon
                        driverKind={ProviderDriverKind.make(session.provider)}
                        displayName={RESUME_PROVIDER_LABELS[session.provider]}
                        size="compact"
                        className="mt-0.5"
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="truncate text-sm text-foreground">
                          {resumeSessionTitle(session)}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {RESUME_PROVIDER_LABELS[session.provider]} ·{" "}
                          {resumeSessionLocation(session, projectWorkspaceRoot)}
                          {age.length > 0 ? ` · ${age}` : ""}
                        </span>
                      </span>
                      {status === null ? null : (
                        <span className="mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                          {status}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {sessions.data?.truncated === true ? (
                <p className="px-3 pt-2 text-xs text-muted-foreground">
                  Showing the newest 100 sessions.
                </p>
              ) : null}
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

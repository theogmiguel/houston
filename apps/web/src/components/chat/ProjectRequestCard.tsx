import { pipe } from "effect/Function";
import {
  projectRequestAnswerInput,
  projectRequestDisplay,
  projectRequestFailureMessage,
  type ProjectRequestItem,
} from "@houston-app/client-runtime/project-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@houston-app/contracts";
import { CheckIcon, LockIcon, MinusIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { StartTruncatedPath } from "../StartTruncatedPath";
import { ExpandableText } from "../settings/ExpandableText";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkLogRow } from "./WorkLog";

/** A long folder path scrolls to its end: the last segments identify the folder. */
function showPathEnd(input: HTMLInputElement | null) {
  if (input !== null) input.scrollLeft = input.scrollWidth;
}

export function ProjectRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: ProjectRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const display = projectRequestDisplay(item, props.visibility);
  if (display.kind === "answered" || display.kind === "pending-elsewhere") {
    const Icon =
      display.kind === "pending-elsewhere"
        ? LockIcon
        : display.outcome === "added"
          ? CheckIcon
          : display.outcome === "failed"
            ? XIcon
            : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            Add project · <StartTruncatedPath path={item.workspaceRoot} /> · {display.label}
          </>
        }
      />
    );
  }
  return (
    <PendingProjectRequestForm
      environmentId={props.environmentId}
      item={item}
      adding={display.adding}
    />
  );
}

function PendingProjectRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: ProjectRequestItem;
  readonly adding: boolean;
}) {
  const { item } = props;
  const answer = useAtomCommand(serverEnvironment.answerProjectRequest, {
    label: "answer add-project request",
    reportFailure: false,
    reportDefect: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter and click can both submit before a render.
  const inFlight = useRef(false);
  const adding = props.adding || submitting;
  const shownError =
    error ?? (item.projectRequestStatus === "failed" ? (item.failure ?? null) : null);
  // A path that cannot register will not register on a second click either;
  // every other answer failure may be transient and must stay retryable.
  const cannotRetry =
    shownError !== null &&
    shownError.includes("is not a folder on this computer. Expected an existing folder.");

  const send = async (decision: "approve" | "decline") => {
    if (inFlight.current || adding) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({
      environmentId: props.environmentId,
      input: projectRequestAnswerInput(item, decision),
    }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      pipe(squashAtomCommandFailure(result), projectRequestFailureMessage, setError);
    }
  };

  return (
    <form
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void send("approve");
      }}
      autoComplete="off"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium text-foreground">Add project</span>
        {item.reason.trim() ? (
          <ExpandableText
            text={item.reason}
            className="text-sm text-muted-foreground"
            expandLabel="Show more"
          />
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <Tooltip>
            <TooltipTrigger render={<div className="min-w-0" />}>
              <Input
                font="mono"
                readOnly
                value={item.workspaceRoot}
                aria-label="Folder to add"
                aria-invalid={shownError !== null || undefined}
                ref={showPathEnd}
              />
            </TooltipTrigger>
            <TooltipPopup side="top" variant="code">
              {item.workspaceRoot}
              <span>
                {item.createsRepository
                  ? "A new folder and git repository will be created."
                  : item.createsFolder
                    ? "A new folder will be created."
                    : "Existing folder."}
              </span>
            </TooltipPopup>
          </Tooltip>
        </div>
        <Button type="submit" disabled={adding || cannotRetry}>
          {adding ? (
            <>
              <Spinner size="xs" aria-hidden />
              Adding…
            </>
          ) : (
            "Add project"
          )}
        </Button>
      </div>
      {shownError !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {shownError}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
          The thread keeps its current access. Only this folder is added.
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={adding}
          onClick={() => void send("decline")}
        >
          Decline
        </Button>
      </div>
    </form>
  );
}

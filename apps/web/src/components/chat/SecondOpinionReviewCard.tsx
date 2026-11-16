import type { ScopedThreadRef } from "@houston-app/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import { useState } from "react";
import { MessagesSquareIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import ChatMarkdown from "../ChatMarkdown";
import { useThreadProjection } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * The read-only result of a second opinion, under the turn it reviews. Its text is not
 * part of the thread until Send to thread queues it as the next message.
 */
export function SecondOpinionReviewCard({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const projection = useThreadProjection(threadRef)?.projection;
  const send = useAtomCommand(threadEnvironment.sendSideThread, { reportFailure: false });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const reviewRun = projection?.runs
    .filter((run) => run.status === "completed")
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  const reviewText =
    reviewRun === undefined
      ? undefined
      : projection?.turnItems
          .filter(
            (
              item,
            ): item is Extract<
              NonNullable<typeof projection>["turnItems"][number],
              { readonly type: "assistant_message" }
            > => item.type === "assistant_message" && item.runId === reviewRun.id,
          )
          .toSorted((left, right) => right.ordinal - left.ordinal)[0]?.text;

  const sendToThread = async () => {
    if (reviewRun === undefined || sending || sent) return;
    setSending(true);
    const result = await send({
      environmentId: threadRef.environmentId,
      input: { sideThreadId: threadRef.threadId, runId: reviewRun.id },
    });
    setSending(false);
    if (result._tag === "Success") {
      setSent(true);
      toastManager.add({
        type: "success",
        title: "Sent to thread",
        description: "The review is queued as the thread's next message.",
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not send the review",
      ...(error instanceof Error ? { description: error.message } : {}),
    });
  };

  if (reviewText === undefined) {
    return (
      <Alert className="mt-2" data-second-opinion-review="pending">
        <Spinner size="sm" />
        <AlertDescription>Reviewing this turn…</AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert className="mt-2" variant="default" data-second-opinion-review="ready">
      <MessagesSquareIcon />
      <AlertTitle>Second opinion</AlertTitle>
      <AlertDescription>
        <ChatMarkdown text={reviewText} cwd={undefined} threadRef={threadRef} />
      </AlertDescription>
      <AlertAction>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={sending || sent}
          onClick={() => void sendToThread()}
        >
          {sending ? <Spinner size="sm" /> : null}
          {sent ? "Sent to thread" : "Send to thread"}
        </Button>
      </AlertAction>
    </Alert>
  );
}

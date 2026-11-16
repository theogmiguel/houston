import type { ScopedThreadRef } from "@houston-app/contracts";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import { useRef } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useRightPanelStore } from "../../rightPanelStore";
import { waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Starts a read-only aside from `threadRef`, or offers none when it is null. `open` forks
 * the thread's latest finished turn into a server side thread, sends `prompt` there when
 * there is one, and shows the aside's tab. The server refuses edit, command and interrupt
 * requests on a side thread, so an aside never changes the source or stops its run.
 */
export function useSideChat(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly onError: (message: string) => void;
}) {
  const pendingRef = useRef(false);
  const startAside = useAtomCommand(threadEnvironment.startAside, { reportFailure: false });
  const reportFailure = (
    failure: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
    fallback: string,
  ) => {
    if (isAtomCommandInterrupted(failure)) return;
    const error = squashAtomCommandFailure(failure);
    input.onError(error instanceof Error ? error.message : fallback);
  };
  const start = async (threadRef: ScopedThreadRef, prompt: string | undefined) => {
    const targetThreadId = newThreadId();
    const text = prompt?.trim() ?? "";
    const aside = await startAside({
      environmentId: threadRef.environmentId,
      input: {
        sourceThreadId: threadRef.threadId,
        asideThreadId: targetThreadId,
        messageId: newMessageId(),
        text,
        attachments: [],
      },
    });
    if (aside._tag === "Failure") {
      reportFailure(aside, "Could not start an aside.");
      return false;
    }
    if (!(await waitForThreadShell(scopeThreadRef(threadRef.environmentId, targetThreadId)))) {
      input.onError("The aside was created, but it did not reach this client.");
      return false;
    }
    useRightPanelStore.getState().openSideChat(threadRef, targetThreadId);
    return true;
  };
  const open = async (prompt?: string) => {
    const { threadRef } = input;
    if (!threadRef || pendingRef.current) return false;
    pendingRef.current = true;
    return start(threadRef, prompt).finally(() => {
      pendingRef.current = false;
    });
  };
  return { available: input.threadRef !== null, open: useStableCallback(open) };
}

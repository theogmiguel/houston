import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import { useEffect, useRef } from "react";

import { detectAutoClosedOnMerge, locallySettledThreadKeys } from "../autoCloseOnMerge";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAllEnvironmentShellsBootstrapped, useQuietThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";

function reopenThread(thread: EnvironmentThreadShell): void {
  void runAtomCommand(
    appAtomRegistry,
    threadEnvironment.unsettle,
    { environmentId: thread.environmentId, input: { threadId: thread.id, reason: "user" } },
    { label: "reopen auto-closed thread", reportFailure: false, reportDefect: false },
  ).then((result) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to reopen thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  });
}

function showAutoClosedOnMergeToast(thread: EnvironmentThreadShell): void {
  const id = toastManager.add({
    type: "info",
    title: `Closed “${thread.title}”`,
    description: "Its pull request merged and auto-close is on. It's in Closed.",
    actionProps: {
      children: "Reopen",
      onClick: () => {
        toastManager.close(id);
        reopenThread(thread);
      },
    },
  });
}

/**
 * Says when auto-close closed a thread on merge, with a Reopen action. It compares live shell
 * updates after the first snapshot, so a thread that arrives already closed stays quiet.
 */
export function useAutoCloseOnMergeToast(): void {
  const shells = useQuietThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const previous = useRef<ReadonlyArray<EnvironmentThreadShell> | null>(null);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- keeps an imperative toast in step with shell updates that close a thread on merge
  useEffect(() => {
    const before = previous.current;
    previous.current = shells;
    if (before === null || !bootstrapped) return;
    const byKey = new Map(
      before.map((thread) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        thread,
      ]),
    );
    for (const next of shells) {
      const key = scopedThreadKey(scopeThreadRef(next.environmentId, next.id));
      const previousShell = byKey.get(key);
      if (previousShell === undefined) continue;
      if (detectAutoClosedOnMerge(previousShell, next, locallySettledThreadKeys())) {
        showAutoClosedOnMergeToast(next);
      }
    }
  }, [shells, bootstrapped]);
}

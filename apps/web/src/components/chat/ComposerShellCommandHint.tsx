import { TerminalIcon } from "lucide-react";

import { Text } from "../ui/text";

export type ComposerShellCommandStatus = "run" | "unavailable";

/**
 * Tells the composer that a leading `!` targets the thread's terminal, not the agent.
 * `unavailableReason` names what is missing when the thread has no terminal to run it in.
 */
export function ComposerShellCommandHint({
  status,
  unavailableReason,
}: {
  readonly status: ComposerShellCommandStatus | null;
  readonly unavailableReason?: string | null | undefined;
}) {
  if (status === null) return null;
  return (
    <p
      data-chat-composer-shell-hint={status}
      className="flex items-center gap-1.5 px-3 pb-2 sm:px-4"
    >
      <TerminalIcon className="size-3.5 shrink-0" aria-hidden />
      <Text as="span" variant="caption" tone="muted">
        {status === "run"
          ? "Runs in the terminal; not sent to the agent."
          : (unavailableReason ?? "This thread has no terminal.")}
      </Text>
    </p>
  );
}

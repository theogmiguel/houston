import { CheckIcon, MonitorIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "./button";
import { Spinner } from "./spinner";

/** The machine a linked search result came from, at the row's right edge. */
export function CommandResultMachine({ label }: { readonly label: string }) {
  return (
    <span className="flex max-w-[11ch] shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <MonitorIcon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** What choosing a linked row will do when its link is not what that needs. */
export function CommandResultAction({ children }: { readonly children: ReactNode }) {
  return <span className="shrink-0 text-(--accent-ink) text-xs">{children}</span>;
}

export function CommandResultConnecting() {
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
      <Spinner size="sm" />
      Connecting
    </span>
  );
}

export function CommandResultConnected() {
  return (
    <span className="flex items-center gap-1.5 text-(--ok-ink) text-xs">
      <CheckIcon className="size-3.5" />
      Connected
    </span>
  );
}

function failureText(status: string): string {
  switch (status) {
    case "timed_out":
      return "is slow, still searching";
    case "off":
      return "has Linked environments turned off";
    case "expired":
      return "link expired";
    default:
      return "isn't answering";
  }
}

/** One line naming the linked machines still searching, or the ones that did not answer. */
export function LinkedSearchStatus({
  searchingLabels,
  failed,
  onRetry,
}: {
  readonly searchingLabels: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<{ readonly label: string; readonly status: string }>;
  readonly onRetry: () => void;
}) {
  if (searchingLabels.length > 0) {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <Spinner size="sm" />
        <span>Searching {searchingLabels.join(", ")}</span>
      </span>
    );
  }
  if (failed.length === 0) return null;
  return (
    <span className="flex items-center gap-2 text-xs">
      <TriangleAlertIcon className="size-3.5 shrink-0 text-warning-foreground" />
      <span>
        {failed.length === 1 ? (
          <>
            <b className="font-medium text-foreground">{failed[0]!.label}</b>{" "}
            {failureText(failed[0]!.status)}
          </>
        ) : (
          <>
            {failed.map((machine, index) => (
              <span key={machine.label}>
                {index > 0 ? ", " : null}
                <b className="font-medium text-foreground">{machine.label}</b>
              </span>
            ))}{" "}
            did not answer
          </>
        )}
      </span>
      <Button variant="ghost" size="xs" onClick={onRetry}>
        Retry
      </Button>
    </span>
  );
}

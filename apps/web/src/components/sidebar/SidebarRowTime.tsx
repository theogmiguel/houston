import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";

export function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

export function threadTimeTimestamp(
  thread: Pick<EnvironmentThreadShell, "latestUserMessageAt" | "updatedAt">,
): string {
  return thread.latestUserMessageAt ?? thread.updatedAt;
}

/**
 * The rail's relative age in the board's vocabulary: now, 4m, 2h, 3d. It
 * subscribes to the minute tick itself, so only this label re-renders.
 */
export function SidebarRowTime({ timestamp }: { timestamp: string | null }) {
  const nowMinute = useNowMinute();
  return timestamp === null ? null : (
    <span className="text-2xs text-secondary-label tabular-nums">
      {compactSidebarTimeLabel(
        formatRelativeTimeLabel(timestamp, Date.parse(`${nowMinute}:00.000Z`)),
      )}
    </span>
  );
}

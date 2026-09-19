import type { DaemonStatus } from "../houston/manage";

export function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// Shared by the Daemon settings section and the command palette's "Quit and
// stop daemon" so the two stop paths never word this differently.
export function stopConfirmCopy(status: DaemonStatus | null): string {
  if (!status) {
    return "This ends an unknown number of live sessions and disarms an unknown number of routines — the daemon did not answer a status check.";
  }
  return `This ends ${pluralize(status.live_sessions.count, "live session")} and disarms ${pluralize(status.routines_enabled, "routine")}.`;
}

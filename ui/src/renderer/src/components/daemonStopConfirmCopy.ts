import type { DaemonStatus } from "../houston/manage";

export function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// The Daemon settings section stops only its selected environment.
export function stopConfirmCopy(status: DaemonStatus | null): string {
  if (!status) {
    return "This ends an unknown number of live sessions and disarms an unknown number of routines — the daemon did not answer a status check.";
  }
  return `This ends ${pluralize(status.live_sessions.count, "live session")} and disarms ${pluralize(status.routines_enabled, "routine")}.`;
}

// The command palette invokes native shutdown across all environments, while
// daemonStatus reports only the local daemon.
export function quitConfirmCopy(status: DaemonStatus | null): string {
  if (!status) {
    return "This stops daemons in all environments, including WSL, and quits Houston. The local daemon did not answer a status check; its live-session and routine counts are unknown.";
  }
  return `This stops daemons in all environments, including WSL, and quits Houston. Local daemon status: ${pluralize(status.live_sessions.count, "live session")} and ${pluralize(status.routines_enabled, "enabled routine")}. Counts for other environments are not available here.`;
}

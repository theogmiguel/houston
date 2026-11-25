import { minuteTick } from "@houston-app/client-runtime/clock";
import { useSyncExternalStore } from "react";

export function useNowMinute(): string {
  return useSyncExternalStore(minuteTick.subscribe, minuteTick.getSnapshot, minuteTick.getSnapshot);
}

/** The current minute is UTC without a zone designator, which `Date.parse` would read as local time. */
export function nowMinuteMs(minute: string): number {
  return Date.parse(`${minute}:00Z`);
}

export function useNowMinuteMs(): number {
  return nowMinuteMs(useNowMinute());
}

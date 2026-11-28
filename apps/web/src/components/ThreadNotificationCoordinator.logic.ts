import { WORKING_EXIT_GRACE_MS } from "@houston-app/client-runtime/state/thread-inbox";

export type ThreadNotificationKind = "input" | "completion";

export interface ThreadNotificationObservation {
  /** Run and status key while the thread needs attention, otherwise null. */
  readonly attention: string | null;
  /** The thread is idle and its latest run completed. */
  readonly settled: boolean;
  /** When the latest run completed, if it did. */
  readonly completedAt: number | null;
}

/**
 * Attention notifies at once. Completion waits out the Working shelf's exit grace,
 * because an orchestrator run can end moments before its continuation starts. Any
 * observation that is not settled during the wait cancels it.
 */
export function createThreadNotificationGate<Key>(
  notify: (key: Key, kind: ThreadNotificationKind) => void,
) {
  const pending = new Map<Key, { at: number; timer: ReturnType<typeof setTimeout> }>();
  // The newest completion already notified, or deliberately skipped.
  const handled = new Map<Key, number>();
  // The newest completion seen settled, kept while the thread works or waits.
  const lastSettled = new Map<Key, number>();
  const cancel = (key: Key) => {
    clearTimeout(pending.get(key)?.timer);
    pending.delete(key);
  };
  const skip = (key: Key, at: number | null) => {
    if (at !== null && at > (handled.get(key) ?? -Infinity)) handled.set(key, at);
  };
  return {
    observe(
      key: Key,
      prior: ThreadNotificationObservation | undefined,
      next: ThreadNotificationObservation,
      options: { readonly archived: boolean; readonly quiet: boolean },
    ): void {
      if (next.settled && next.completedAt !== null) lastSettled.set(key, next.completedAt);
      if (!next.settled || options.archived || options.quiet) cancel(key);
      // The first sighting, archived threads, and stopped or silent runs never notify completion.
      if (!prior || options.archived || options.quiet) skip(key, next.completedAt);
      if (!prior || options.archived) return;
      if (next.attention && next.attention !== prior.attention) {
        // Attention replaces the completion before it, so that run must not notify later.
        skip(key, lastSettled.get(key) ?? null);
        cancel(key);
        notify(key, "input");
        return;
      }
      const at = next.completedAt;
      if (!next.settled || at === null || at <= (handled.get(key) ?? -Infinity)) return;
      if (pending.get(key)?.at === at) return;
      cancel(key);
      pending.set(key, {
        at,
        timer: setTimeout(() => {
          pending.delete(key);
          handled.set(key, at);
          notify(key, "completion");
        }, WORKING_EXIT_GRACE_MS),
      });
    },
    /** Forgets threads that left the snapshot. */
    retain(keys: ReadonlySet<Key>): void {
      for (const key of pending.keys()) if (!keys.has(key)) cancel(key);
      for (const key of handled.keys()) if (!keys.has(key)) handled.delete(key);
      for (const key of lastSettled.keys()) if (!keys.has(key)) lastSettled.delete(key);
    },
    cancelPending(): void {
      for (const key of pending.keys()) cancel(key);
    },
    clear(): void {
      for (const key of pending.keys()) cancel(key);
      handled.clear();
      lastSettled.clear();
    },
  };
}

export const WAITING_NOTICE_REMINDER_MS = 30 * 60_000;
export const WAITING_NOTICE_TITLE_MAX_CHARS = 120;
const WAITING_NOTICE_WHITESPACE = /\s+/g;

export type WaitingNoticeKind = "question" | "approval";
/** How the existing input notice already handled this request, if it did. */
export type WaitingNoticeExistingOutcome = "announced" | "sound" | "none";

export interface WaitingNoticeRequest {
  readonly key: string;
  readonly kind: WaitingNoticeKind;
  /** A bounded, plain-text thread title. */
  readonly title: string;
  readonly existingOutcome: WaitingNoticeExistingOutcome;
}

export interface WaitingNotice {
  readonly key: string;
  readonly kind: WaitingNoticeKind;
  readonly title: string;
  readonly reminder: boolean;
  /** The mode already played a sound for this request, so do not play another. */
  readonly playSound: boolean;
}

export function waitingRequestKind(
  request: { readonly kind: string } | null | undefined,
): WaitingNoticeKind | null {
  if (request === null || request === undefined || request.kind === "auth_refresh") return null;
  return request.kind === "user_input" ? "question" : "approval";
}

/** One plain line, bounded so an agent-written title cannot carry more than a label. */
export function boundedWaitNoticeText(text: string): string {
  const plain = text.replace(WAITING_NOTICE_WHITESPACE, " ").trim();
  if (plain.length === 0) return "Untitled thread";
  return Array.from(plain).slice(0, WAITING_NOTICE_TITLE_MAX_CHARS).join("");
}

/**
 * Announces each pending request once, and reminds once if it is still pending after thirty
 * minutes. A request the existing input notice announced keeps that notice as its only one.
 */
export function createWaitingNoticeTracker<Key extends string = string>(
  notify: (notice: WaitingNotice) => void,
  reminderMs: number = WAITING_NOTICE_REMINDER_MS,
) {
  const tracked = new Map<Key, { readonly timer: ReturnType<typeof setTimeout> }>();
  const cancel = (key: Key) => {
    clearTimeout(tracked.get(key)?.timer);
    tracked.delete(key);
  };
  return {
    sync(requests: ReadonlyArray<WaitingNoticeRequest>): void {
      const seen = new Set<string>();
      for (const request of requests) {
        seen.add(request.key);
        if (tracked.has(request.key as Key)) continue;
        if (request.existingOutcome !== "announced") {
          notify({
            key: request.key,
            kind: request.kind,
            title: request.title,
            reminder: false,
            playSound: request.existingOutcome === "none",
          });
        }
        const timer = setTimeout(() => {
          notify({
            key: request.key,
            kind: request.kind,
            title: request.title,
            reminder: true,
            playSound: true,
          });
        }, reminderMs);
        tracked.set(request.key as Key, { timer });
      }
      for (const key of tracked.keys()) if (!seen.has(key)) cancel(key);
    },
    clear(): void {
      for (const key of tracked.keys()) cancel(key);
    },
  };
}

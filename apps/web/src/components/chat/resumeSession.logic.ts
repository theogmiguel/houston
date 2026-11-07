import type { ThreadId } from "@houston-app/contracts";
import type { HoustonResumeSession } from "@houston-app/contracts/houston/resumeSessions";

export const RESUME_PROVIDER_LABELS = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  pi: "Pi",
} as const;

/** One provider session may appear twice when two transcripts describe it. */
export function resumeSessionKey(session: HoustonResumeSession): string {
  return `${session.providerInstanceId}\u0000${session.providerSessionId}`;
}

export function resumeSessionRows(
  sessions: ReadonlyArray<HoustonResumeSession>,
): ReadonlyArray<HoustonResumeSession> {
  const newestByKey = new Map<string, HoustonResumeSession>();
  for (const session of sessions) {
    const key = resumeSessionKey(session);
    const current = newestByKey.get(key);
    if (current === undefined || current.lastActiveAt < session.lastActiveAt) {
      newestByKey.set(key, session);
    }
  }
  return [...newestByKey.values()].toSorted((left, right) =>
    right.lastActiveAt.localeCompare(left.lastActiveAt),
  );
}

export function resumeSessionTitle(session: HoustonResumeSession): string {
  const title = session.title?.trim();
  if (title !== undefined && title.length > 0) return title;
  const firstLine = session.firstPrompt?.split("\n")[0]?.trim();
  return firstLine !== undefined && firstLine.length > 0 ? firstLine : "Untitled session";
}

const TRAILING_SLASHES = /\/+$/;

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(TRAILING_SLASHES, "");
}

export function resumeSessionLocation(
  session: HoustonResumeSession,
  projectWorkspaceRoot: string,
): string {
  const folder = normalizedPath(session.folder);
  const root = normalizedPath(projectWorkspaceRoot);
  const folderLabel =
    folder === root ? "Project root" : (folder.split("/").at(-1) ?? session.folder);
  return session.branch === null ? folderLabel : `${folderLabel} · ${session.branch}`;
}

export type ResumeSelectionPlan =
  | { readonly action: "open"; readonly threadId: ThreadId }
  | { readonly action: "confirm" }
  | { readonly action: "import" };

/** An owned session opens its thread; an unowned one imports unless a CLI may still hold it. */
export function planResumeSelection(session: HoustonResumeSession): ResumeSelectionPlan {
  if (session.threadId !== null) return { action: "open", threadId: session.threadId };
  if (session.mayBeRunningElsewhere) return { action: "confirm" };
  return { action: "import" };
}

export function resumeSessionStatusLabel(session: HoustonResumeSession): string | null {
  if (session.live) return "Running";
  if (session.threadId !== null) return "Open thread";
  if (session.mayBeRunningElsewhere) return "May be running";
  return null;
}

import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentShellStatus } from "@houston-app/client-runtime/state/shell";
import type { EnvironmentThreadState } from "@houston-app/client-runtime/state/threads";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@houston-app/contracts";
import * as Option from "effect/Option";
import type { DraftId } from "./composerDraftStore";

export type ThreadRouteTarget =
  | {
      kind: "server";
      threadRef: ScopedThreadRef;
    }
  | {
      kind: "draft";
      draftId: DraftId;
    };

type DraftThreadRouteState = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  promotedTo?: ScopedThreadRef | null;
};

export type ThreadRouteRenderState = "loading" | "ready" | "missing";

export function isThreadRouteSnapshotAuthoritative(
  status: EnvironmentShellStatus | null | undefined,
): boolean {
  return status === "live";
}

export function resolveThreadRouteRenderState(input: {
  bootstrapComplete: boolean;
  serverThreadExists: boolean;
  serverThreadDeleted: boolean;
  unlistedThreadDetail: EnvironmentThreadState;
  draftThreadExists: boolean;
}): ThreadRouteRenderState {
  if (input.draftThreadExists || (input.serverThreadExists && !input.serverThreadDeleted)) {
    return "ready";
  }
  if (!input.bootstrapComplete) {
    return "loading";
  }
  if (input.serverThreadExists || input.unlistedThreadDetail.status === "deleted") {
    return "missing";
  }
  // Shell membership can lag a new thread; its detail decides.
  const projection = Option.getOrNull(input.unlistedThreadDetail.data);
  if (projection === null) {
    return "loading";
  }
  return projection.thread.deletedAt !== null || projection.thread.archivedAt !== null
    ? "missing"
    : "ready";
}

export function buildThreadRouteParams(ref: ScopedThreadRef): {
  environmentId: EnvironmentId;
  threadId: ThreadId;
} {
  return {
    environmentId: ref.environmentId,
    threadId: ref.threadId,
  };
}

/**
 * The thread a location pathname names when it has the thread route's shape,
 * `/$environmentId/$threadId`, or null. Ids such as `mcp:<uuid>` reach the address bar
 * percent-encoded, so each segment is decoded. A two-segment page such as `/settings/about` has the
 * same shape, so the result names a thread only once a thread with that id exists.
 */
const TRAILING_SLASH = /\/$/;

export function parseThreadRoutePathname(pathname: string): ScopedThreadRef | null {
  const segments = pathname.replace(TRAILING_SLASH, "").split("/").map(decodeSegment);
  if (segments.length !== 3 || segments[0] !== "" || !segments[1] || !segments[2]) return null;
  return scopeThreadRef(segments[1] as EnvironmentId, segments[2] as ThreadId);
}

/** Whether a location pathname is `ref`'s own thread route, `/$environmentId/$threadId`. */
export function isThreadRoutePathname(pathname: string, ref: ScopedThreadRef): boolean {
  const { environmentId, threadId } = buildThreadRouteParams(ref);
  const parsed = parseThreadRoutePathname(pathname);
  return parsed !== null && parsed.environmentId === environmentId && parsed.threadId === threadId;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function buildDraftThreadRouteParams(draftId: DraftId): {
  draftId: DraftId;
} {
  return { draftId };
}

export function resolveThreadRouteRef(
  params: Partial<Record<"environmentId" | "threadId", string | undefined>>,
): ScopedThreadRef | null {
  if (!params.environmentId || !params.threadId) {
    return null;
  }

  return scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId);
}

export function resolveThreadRouteTarget(
  params: Partial<Record<"environmentId" | "threadId" | "draftId", string | undefined>>,
): ThreadRouteTarget | null {
  if (params.environmentId && params.threadId) {
    return {
      kind: "server",
      threadRef: scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId),
    };
  }

  if (!params.draftId) {
    return null;
  }

  return {
    kind: "draft",
    draftId: params.draftId as DraftId,
  };
}

export function resolveActiveThreadRouteRef(
  target: ThreadRouteTarget | null,
  draftThread: DraftThreadRouteState | null,
): ScopedThreadRef | null {
  if (target?.kind === "server") {
    return target.threadRef;
  }
  if (target?.kind !== "draft" || !draftThread?.promotedTo) {
    return null;
  }
  return draftThread.promotedTo;
}

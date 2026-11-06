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
 * Whether a location pathname is `ref`'s own thread route, `/$environmentId/$threadId`.
 * Ids such as `mcp:<uuid>` reach the address bar percent-encoded, so each segment is compared decoded.
 */
export function isThreadRoutePathname(pathname: string, ref: ScopedThreadRef): boolean {
  const { environmentId, threadId } = buildThreadRouteParams(ref);
  const segments = pathname.replace(/\/$/, "").split("/").map(decodeSegment);
  return (
    segments.length === 3 &&
    segments[0] === "" &&
    segments[1] === environmentId &&
    segments[2] === threadId
  );
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

import {
  AuthFilesystemWriteScope,
  ProjectWriteFileError,
  type EnvironmentId,
} from "@houston-app/contracts";
import {
  type AtomCommandResult,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useEffect, useSyncExternalStore } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { environmentSession, readEnvironmentScope, sessionHasScope } from "~/state/session";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  getProjectFileRevision,
  getUnsavedProjectFileQueryData,
  setProjectFileRevision,
} from "./projectFilesQueryState";

export interface FileSaveTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

export type FilePendingListener = (relativePath: string, pending: boolean) => void;

export interface FileSaveSessionDeps {
  readonly debounceMs: number;
  readonly canPersist: (target: FileSaveTarget) => boolean;
  /** Calls `onWritable` each time the target environment regains write access. */
  readonly subscribeWritable: (target: FileSaveTarget, onWritable: () => void) => () => void;
  readonly revision: (target: FileSaveTarget) => string | undefined;
  readonly persist: (
    target: FileSaveTarget,
    contents: string,
    expectedRevision: string | undefined,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly onPersisted: (target: FileSaveTarget, result: unknown) => void;
  readonly confirm: (target: FileSaveTarget, contents: string) => boolean;
  readonly readUnsaved: (target: FileSaveTarget) => string | null;
}

interface FileSaveSession {
  readonly coordinator: FileSaveCoordinator;
  /** Lease count per listener; surfaces may share one listener. */
  readonly listeners: Map<FilePendingListener, number>;
  readonly unsubscribeWritable: () => void;
  leases: number;
  /** The last release flushed, and the session stays open until that settles. */
  flushingOnRelease: boolean;
}

/**
 * One save session, so one ordered write queue, per file. A released session
 * stays open until its flush settles, so a surface rejoining meanwhile reuses
 * it instead of racing the flush. A session that cannot write closes at once,
 * and the next one, or regained write access, resumes the unsaved draft.
 */
export function createFileSaveSessions(deps: FileSaveSessionDeps) {
  const sessions = new Map<string, FileSaveSession>();

  const recover = (target: FileSaveTarget, coordinator: FileSaveCoordinator) => {
    if (!deps.canPersist(target)) return;
    const unsaved = deps.readUnsaved(target);
    if (unsaved !== null) coordinator.change(unsaved);
  };

  const create = (key: string, target: FileSaveTarget): FileSaveSession => {
    const listeners = new Map<FilePendingListener, number>();
    const coordinator: FileSaveCoordinator = new FileSaveCoordinator({
      debounceMs: deps.debounceMs,
      canPersist: () => deps.canPersist(target),
      // The last surface's listeners outlive it: a flush that settles after
      // the session is released still has to clear the pending marker.
      onPendingChange: (pending) => {
        for (const listener of listeners.keys()) listener(target.relativePath, pending);
      },
      currentRevision: () => deps.revision(target),
      persist: async (contents, expectedRevision) => {
        const result = await deps.persist(target, contents, expectedRevision);
        if (result._tag === "Failure" && expectedRevision !== undefined) {
          const cause = squashAtomCommandFailure(result);
          if (isProjectWriteFileError(cause) && cause.failure === "stale_revision") {
            markFileSaveConflict(target);
          }
        }
        return result;
      },
      onConfirmed: (contents) => {
        clearFileSaveConflict(target);
        return deps.confirm(target, contents);
      },
      onPersisted: (result) => deps.onPersisted(target, result),
      onSettled: () => {
        if (!session.flushingOnRelease) return;
        session.flushingOnRelease = false;
        if (session.leases === 0) {
          if (sessions.get(key) === session) sessions.delete(key);
          session.unsubscribeWritable();
        } else if (coordinator.unconfirmedContents !== null) {
          // A surface rejoined while the release flush failed; retry it once.
          recover(target, coordinator);
        }
      },
    });
    const unsubscribeWritable = deps.subscribeWritable(target, () => recover(target, coordinator));
    const session: FileSaveSession = {
      coordinator,
      listeners,
      unsubscribeWritable,
      leases: 0,
      flushingOnRelease: false,
    };
    return session;
  };

  const acquire = (target: FileSaveTarget, onPendingChange: FilePendingListener): (() => void) => {
    const key = fileSaveKey(target);
    const existing = sessions.get(key);
    const session = existing ?? create(key, target);
    sessions.set(key, session);
    session.leases += 1;
    session.listeners.set(onPendingChange, (session.listeners.get(onPendingChange) ?? 0) + 1);
    if (!existing) recover(target, session.coordinator);
    else if (session.coordinator.unconfirmedContents !== null) {
      onPendingChange(target.relativePath, true);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      session.leases -= 1;
      if (session.leases > 0) {
        const count = (session.listeners.get(onPendingChange) ?? 1) - 1;
        if (count > 0) session.listeners.set(onPendingChange, count);
        else session.listeners.delete(onPendingChange);
        return;
      }
      session.flushingOnRelease = true;
      session.coordinator.flush();
    };
  };

  return {
    /** Holds the file's session open until the returned release runs. */
    acquire,
    /** Edits for a file nobody holds open are dropped, so retired editors stay inert. */
    change(target: FileSaveTarget, contents: string): void {
      const session = sessions.get(fileSaveKey(target));
      if (session && session.leases > 0) session.coordinator.change(contents);
    },
    reset(target: FileSaveTarget, contents: string): void {
      sessions.get(fileSaveKey(target))?.coordinator.reset(contents);
    },
    overwrite(target: FileSaveTarget): void {
      sessions.get(fileSaveKey(target))?.coordinator.overwrite();
    },
  };
}

function fileSaveKey({ environmentId, cwd, relativePath }: FileSaveTarget): string {
  return `${environmentId}\u0000${cwd}\u0000${relativePath}`;
}

const isProjectWriteFileError = Schema.is(ProjectWriteFileError);

const fileSaveSessions = createFileSaveSessions({
  debounceMs: 500,
  canPersist: ({ environmentId }) => readEnvironmentScope(environmentId, AuthFilesystemWriteScope),
  subscribeWritable: ({ environmentId }, onWritable) => {
    let writable = readEnvironmentScope(environmentId, AuthFilesystemWriteScope);
    return appAtomRegistry.subscribe(
      environmentSession.sessionStateAtom(environmentId),
      (state) => {
        const next = sessionHasScope(state, AuthFilesystemWriteScope);
        if (next && !writable) onWritable();
        writable = next;
      },
    );
  },
  revision: ({ environmentId, cwd, relativePath }) =>
    getProjectFileRevision(environmentId, cwd, relativePath),
  persist: ({ environmentId, cwd, relativePath }, contents, expectedRevision) =>
    runAtomCommand(appAtomRegistry, projectEnvironment.writeFile, {
      environmentId,
      input: {
        cwd,
        relativePath,
        contents,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      },
    }),
  onPersisted: ({ environmentId, cwd, relativePath }, result) => {
    if (typeof result !== "object" || result === null || !("revision" in result)) return;
    const revision = result.revision;
    if (typeof revision === "string" && revision.length > 0) {
      setProjectFileRevision(environmentId, cwd, relativePath, revision);
    }
  },
  confirm: ({ environmentId, cwd, relativePath }, contents) =>
    confirmProjectFileQueryData(environmentId, cwd, relativePath, contents),
  readUnsaved: ({ environmentId, cwd, relativePath }) =>
    getUnsavedProjectFileQueryData(environmentId, cwd, relativePath)?.contents ?? null,
});

/** Holds the file's save session while the surface is mounted; the last surface to leave flushes. */
export function useFileSaveSession(
  { environmentId, cwd, relativePath }: FileSaveTarget,
  onPendingChange: FilePendingListener,
): void {
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- the lease is a mount-scoped external resource; React runs every unmount cleanup before mount setups, so a surface switch flushes before the next surface recovers.
  useEffect(
    () => fileSaveSessions.acquire({ environmentId, cwd, relativePath }, onPendingChange),
    [environmentId, cwd, relativePath, onPendingChange],
  );
}

export function changeFileSaveSession(target: FileSaveTarget, contents: string): void {
  fileSaveSessions.change(target, contents);
}

const conflictKeys = new Set<string>();
const conflictListeners = new Set<() => void>();

function notifyConflictListeners(): void {
  for (const listener of conflictListeners) listener();
}

function markFileSaveConflict(target: FileSaveTarget): void {
  const key = fileSaveKey(target);
  if (conflictKeys.has(key)) return;
  conflictKeys.add(key);
  notifyConflictListeners();
}

export function clearFileSaveConflict(target: FileSaveTarget): void {
  if (!conflictKeys.delete(fileSaveKey(target))) return;
  notifyConflictListeners();
}

function subscribeFileSaveConflicts(listener: () => void): () => void {
  conflictListeners.add(listener);
  return () => conflictListeners.delete(listener);
}

export function useFileSaveConflict(target: FileSaveTarget): boolean {
  return useSyncExternalStore(
    subscribeFileSaveConflicts,
    () => conflictKeys.has(fileSaveKey(target)),
    () => false,
  );
}

/** Discards the draft in favour of contents another process wrote. */
export function resetFileSaveSession(target: FileSaveTarget, contents: string): void {
  clearFileSaveConflict(target);
  fileSaveSessions.reset(target, contents);
}

/** Writes the newest draft even though the file changed on disk. */
export function overwriteFileSaveSession(target: FileSaveTarget): void {
  clearFileSaveConflict(target);
  fileSaveSessions.overwrite(target);
}

import {
  type DesktopTrayConnection,
  type DesktopTrayPayload,
  type DesktopTrayStatus,
  type EnvironmentId,
  type ProviderInstanceId,
  type ThreadId,
} from "@houston-app/contracts";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { isShownUnderParent } from "@houston-app/client-runtime/state/threads";
import type { AnyRouter } from "@tanstack/react-router";
import type { AtomRegistry } from "effect/reactivity";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { environmentPresentations } from "../state/presentation";
import { environmentProjects } from "../state/projects";
import { environmentThreadShells } from "../state/threads";

const TRAY_SYNC_MIN_INTERVAL_MS = 250;

export function trayThreadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}:${threadId}`;
}

function parseTrayThreadKey(
  key: string,
): { environmentId: EnvironmentId; threadId: ThreadId } | null {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) return null;
  return {
    environmentId: key.slice(0, separator) as EnvironmentId,
    threadId: key.slice(separator + 1) as ThreadId,
  };
}

export function trayConnection(phases: ReadonlyArray<string>): DesktopTrayConnection {
  if (phases.some((phase) => phase === "connected")) return "ready";
  if (phases.some((phase) => phase === "error" || phase === "unsupported")) return "failed";
  if (phases.some((phase) => phase === "connecting")) return "connecting";
  return "reconnecting";
}

function trayStatus(thread: EnvironmentThreadShell): {
  status: DesktopTrayStatus;
  needsInput: boolean;
} {
  const status = resolveSidebarThreadStatus(thread);
  switch (status) {
    case "input":
    case "approval":
      return { status: "needsInput", needsInput: true };
    case "failed":
    case "limited":
      return { status: "error", needsInput: false };
    case "working":
      return { status: "running", needsInput: false };
    case "waiting":
      return { status: "idle", needsInput: false };
    case "ready":
      return {
        status: thread.latestRun?.status === "completed" ? "done" : "idle",
        needsInput: false,
      };
  }
}

export function buildTrayPayload(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  phases: ReadonlyArray<string>,
  projectTitles: ReadonlyMap<string, string>,
  providerDrivers: ReadonlyMap<ProviderInstanceId, string>,
  delegatedUnderParent: ReadonlySet<string>,
): DesktopTrayPayload {
  const sessions = threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        !isShownUnderParent(
          { environmentId: thread.environmentId, threadId: thread.id },
          thread.lineage,
          delegatedUnderParent,
        ),
    )
    .map((thread) => {
      const tray = trayStatus(thread);
      const projectTitle = projectTitles.get(`${thread.environmentId}:${thread.projectId}`);
      return {
        id: trayThreadKey(thread.environmentId, thread.id),
        agent: providerDrivers.get(thread.providerInstanceId) ?? thread.providerInstanceId,
        title: thread.title,
        status: tray.status,
        needsInput: tray.needsInput,
        workspace: projectTitle ?? "Houston",
      };
    });
  return { connection: trayConnection(phases), sessions };
}

export function startTraySync(registry: AtomRegistry.AtomRegistry, router: AnyRouter): () => void {
  const bridge = window.hostBridge;
  if (!bridge?.traySync) return () => {};

  let timer: number | null = null;
  let pending: DesktopTrayPayload | null = null;
  let lastSentAt = Number.NEGATIVE_INFINITY;

  const send = (payload: DesktopTrayPayload) => {
    lastSentAt = Date.now();
    void bridge.traySync?.(payload);
  };

  const publish = () => {
    const delegatedUnderParent = registry.get(environmentThreadShells.delegatedUnderParentAtom);
    const projects = registry.get(environmentProjects.projectsAtom);
    const projectTitles = new Map(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
    );
    const providers = registry.get(environmentPresentations.providersByEnvironmentAtom);
    const providerDrivers = new Map<ProviderInstanceId, string>();
    for (const instances of providers.values()) {
      for (const instance of instances) {
        providerDrivers.set(instance.instanceId, instance.driver);
      }
    }
    const presentations = registry.get(environmentPresentations.presentationsAtom);
    const payload = buildTrayPayload(
      registry.get(environmentThreadShells.threadShellsAtom),
      [...presentations.values()].map((presentation) => presentation.connection.phase),
      projectTitles,
      providerDrivers,
      delegatedUnderParent,
    );
    const elapsed = Date.now() - lastSentAt;
    if (elapsed >= TRAY_SYNC_MIN_INTERVAL_MS && timer === null) {
      send(payload);
      return;
    }
    pending = payload;
    if (timer !== null) return;
    timer = window.setTimeout(
      () => {
        timer = null;
        const next = pending;
        pending = null;
        if (next !== null) send(next);
      },
      Math.max(0, TRAY_SYNC_MIN_INTERVAL_MS - elapsed),
    );
  };

  const unsubscribers = [
    registry.subscribe(environmentThreadShells.threadShellsAtom, publish, { immediate: true }),
    registry.subscribe(environmentProjects.projectsAtom, publish),
    registry.subscribe(environmentPresentations.presentationsAtom, publish),
    registry.subscribe(environmentThreadShells.delegatedUnderParentAtom, publish),
    registry.subscribe(environmentPresentations.providersByEnvironmentAtom, publish),
  ];
  const unsubscribeFocus = bridge.onTrayFocus?.((key) => {
    const target = parseTrayThreadKey(key);
    if (!target) return;
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: target,
    });
  });

  return () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    pending = null;
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribeFocus?.();
  };
}

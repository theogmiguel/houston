import type { ScopedProjectRef, EnvironmentId } from "@houston-app/contracts";
import { lazy, Suspense, useEffect } from "react";
import { create } from "zustand";

import { preloadWhenIdle } from "../lib/preloadWhenIdle";
import { readProject, subscribeProject } from "../state/entities";
import { RenderErrorBoundary } from "./RenderErrorBoundary";

const loadDialog = () => import("./AddProjectToMachineDialogForm");
const AddProjectToMachineDialog = lazy(() =>
  loadDialog().then((module) => ({ default: module.AddProjectToMachineDialog })),
);

export interface AddProjectToMachineRequest {
  readonly projectRef: ScopedProjectRef;
  readonly targetEnvironmentId: EnvironmentId | null;
}

const useRequest = create<{ request: AddProjectToMachineRequest | null; session: number }>(() => ({
  request: null,
  session: 0,
}));

let endRequestWithProject: (() => void) | null = null;

/** Opens the dialog that clones a project onto another connected machine. */
export function openAddProjectToMachine(request: AddProjectToMachineRequest) {
  if (readProject(request.projectRef) === null) return;
  endRequestWithProject?.();
  // The request ends when its project goes away, so a project that comes back
  // later cannot reopen a dialog nobody asked for.
  endRequestWithProject = subscribeProject(request.projectRef, (project) => {
    if (project === null) close();
  });
  useRequest.setState((state) => ({ request, session: state.session + 1 }));
}

function close() {
  endRequestWithProject?.();
  endRequestWithProject = null;
  useRequest.setState({ request: null });
}

export function AddProjectToMachineDialogHost() {
  const request = useRequest((state) => state.request);
  const session = useRequest((state) => state.session);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- an idle callback that fetches the dialog's chunk early; unmount cancels it.
  useEffect(() => preloadWhenIdle(loadDialog), []);
  if (!request) return null;
  return (
    <RenderErrorBoundary fallback={null} resetKeys={[session]}>
      <Suspense fallback={null}>
        <AddProjectToMachineDialog key={session} request={request} onClose={close} />
      </Suspense>
    </RenderErrorBoundary>
  );
}

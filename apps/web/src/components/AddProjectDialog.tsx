import {
  addProjectRemoteSourceLabel,
  buildAddProjectRemoteSourceReadiness,
  canCreateProjectInEnvironment,
  sortAddProjectProviderSources,
} from "@houston-app/client-runtime/operations/projects";
import { FolderOpenIcon, FolderPlusIcon, GitForkIcon } from "lucide-react";
import { create } from "zustand";

import type { AddProjectFlowRequest } from "../addProjectFlow";
import { openCommandPalette } from "../commandPaletteBus";
import { useEnvironmentQuery } from "../state/query";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { remoteProjectSourceIcon } from "../sourceControlPresentation";
import {
  AddProjectDialogView,
  type AddProjectDialogAction,
  type AddProjectDialogIntegration,
} from "./ui/add-project-dialog";

const useOpen = create<{ readonly open: boolean; readonly session: number }>(() => ({
  open: false,
  session: 0,
}));

/** Opens the chooser for a project that already exists locally, a clone, or a new repository. */
export function openAddProjectDialog(): void {
  useOpen.setState((state) => ({ open: true, session: state.session + 1 }));
}

function closeAddProjectDialog(): void {
  useOpen.setState({ open: false });
}

export function AddProjectDialogHost() {
  const open = useOpen((state) => state.open);
  const session = useOpen((state) => state.session);
  return open ? <AddProjectDialog key={session} /> : null;
}

function AddProjectDialog() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connected = environments.filter((environment) =>
    canCreateProjectInEnvironment(environment.connection.phase),
  );
  const environment =
    connected.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    connected[0] ??
    null;
  const discovery = useEnvironmentQuery(
    environment === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId: environment.environmentId,
          input: {},
        }),
  );
  const readiness = buildAddProjectRemoteSourceReadiness(discovery.data ?? null);
  const integrations: ReadonlyArray<AddProjectDialogIntegration> = sortAddProjectProviderSources(
    readiness,
  )
    .filter((source) => readiness(source).ready)
    .map((source) => ({
      id: source,
      icon: remoteProjectSourceIcon(source, "size-3.5"),
      name: addProjectRemoteSourceLabel(source),
      onSelect: () =>
        startFlow({
          action: "clone",
          ...(environment === null ? {} : { environmentId: environment.environmentId }),
          source,
        }),
    }));

  const startFlow = (request: AddProjectFlowRequest) => {
    closeAddProjectDialog();
    openCommandPalette({ open: "add-project", addProject: request });
  };

  const actions: ReadonlyArray<AddProjectDialogAction> = [
    {
      id: "open-folder",
      icon: <FolderOpenIcon aria-hidden />,
      heading: "Open folder",
      description: "A project already on this computer",
      onSelect: () => startFlow({ action: "open-folder" }),
    },
    {
      id: "clone",
      icon: <GitForkIcon aria-hidden />,
      heading: "Clone repository",
      description: "From a Git URL",
      onSelect: () => startFlow({ action: "clone" }),
    },
    {
      id: "new-project",
      icon: <FolderPlusIcon aria-hidden />,
      heading: "New project",
      description: "An empty Git repository",
      onSelect: () => startFlow({ action: "new-project" }),
    },
  ];

  return (
    <AddProjectDialogView
      actions={actions}
      integrations={integrations}
      onClose={closeAddProjectDialog}
    />
  );
}

import { useAllEnvironmentShellsBootstrapped, useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";

export interface IndexLayoutInputs {
  readonly hostedStatic: boolean;
  readonly environmentsReady: boolean;
  readonly environmentCount: number;
  readonly hasProjects: boolean;
  readonly bootstrapped: boolean;
}

/**
 * Whether the index ("/") shows the layout: what it holds, or its empty
 * workspace's launcher. Before there is anything to start a thread in, the
 * index route's own onboarding shows instead (no projects, no environment).
 */
export function indexShowsLayout(inputs: IndexLayoutInputs): boolean {
  if (inputs.hostedStatic && (!inputs.environmentsReady || inputs.environmentCount === 0)) {
    return false;
  }
  return inputs.hasProjects || !inputs.bootstrapped;
}

export function useIndexShowsLayout(hostedStatic: boolean): boolean {
  const { environments, isReady } = useEnvironments();
  const hasProjects = useProjects().length > 0;
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  return indexShowsLayout({
    hostedStatic,
    environmentsReady: isReady,
    environmentCount: environments.length,
    hasProjects,
    bootstrapped,
  });
}

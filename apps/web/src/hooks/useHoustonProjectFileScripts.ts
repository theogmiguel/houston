import {
  HOUSTON_PROJECT_FILE_NAME,
  type EnvironmentId,
  type HoustonProjectFile,
  type HoustonProjectFileScript,
} from "@houston-app/contracts";
import { parseHoustonProjectFile } from "@houston-app/shared/houstonProjectFile";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<HoustonProjectFileScript> = [];

export interface HoustonProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  file: HoustonProjectFile | null;
  scripts: ReadonlyArray<HoustonProjectFileScript>;
}

export function useHoustonProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): HoustonProjectFileState {
  const query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    HOUSTON_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  if (contents === null) {
    return {
      status: isPending ? "loading" : "missing",
      file: null,
      scripts: NO_SCRIPTS,
    } as const;
  }
  const file = parseHoustonProjectFile(contents);
  if (file === null) {
    return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
  }
  return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
}

export function useHoustonProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<HoustonProjectFileScript> {
  return useHoustonProjectFileState(environmentId, cwd).scripts;
}

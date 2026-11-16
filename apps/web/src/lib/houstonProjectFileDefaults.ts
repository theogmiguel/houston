import {
  HOUSTON_PROJECT_FILE_NAME,
  type EnvironmentId,
  type HoustonProjectFile,
} from "@houston-app/contracts";
import { parseHoustonProjectFile } from "@houston-app/shared/houstonProjectFile";
import { executeAtomQuery } from "@houston-app/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export async function readHoustonProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<HoustonProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, HOUSTON_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    HOUSTON_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.exists === false || data.truncated) return null;
  return parseHoustonProjectFile(data.contents);
}

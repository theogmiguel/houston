import { createAssetEnvironmentAtoms } from "@t3tools/client-runtime/state/assets";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { isElectron } from "../env";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentSession } from "./session";

const localMediaEnvironment = Atom.make((get) => {
  if (!isElectron) return null;
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  const connection = get(environmentSession.preparedConnectionValueAtom(environmentId));
  const config = get(environmentSession.initialConfigValueAtom(environmentId));
  return connection._tag === "None" || config === null
    ? null
    : { environmentId, httpBaseUrl: connection.value.httpBaseUrl };
});

export const assetEnvironment = createAssetEnvironmentAtoms(
  connectionAtomRuntime,
  localMediaEnvironment,
);

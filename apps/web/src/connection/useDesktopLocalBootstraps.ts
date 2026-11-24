import { useAtomValue } from "@effect/atom-react";
import type { DesktopEnvironmentBootstrap } from "@houston-app/contracts";
import { Atom } from "effect/reactivity";

import { readDesktopSecondaryBootstraps } from "./desktopLocal";
import { subscribeDesktopLocalTopology } from "./desktopLocalTopology";

/**
 * Re-reads on the host's notices and the shared safety poll. An unchanged read returns the same
 * array, so it notifies no one; a failed read keeps the latest successful snapshot.
 */
export const desktopLocalBootstrapsAtom = Atom.make((get) => {
  get.addFinalizer(
    subscribeDesktopLocalTopology(() => get.setSelf(readDesktopSecondaryBootstraps())),
  );
  return readDesktopSecondaryBootstraps();
}).pipe(Atom.withLabel("desktop-local-bootstraps"));

export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return useAtomValue(desktopLocalBootstrapsAtom);
}

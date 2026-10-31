// Night shift as the server composes it: the runner with its ports, the claim upstream's scheduled
// tasks ask, and the RPC service with the catch-up of a missed night.
import * as Layer from "effect/Layer";

import * as NightShiftGit from "./Git.ts";
import { layerMachine, layerMergeQueueUnset, layerProviders } from "./Host.ts";
import * as KeepAwake from "./KeepAwake.ts";
import * as Runner from "./Runner.ts";
import { layerCatchUp, layerClaim } from "./ScheduledTaskRunner.ts";
import * as Service from "./Service.ts";
import * as Threads from "./Threads.ts";

/** The ports the runner and the service read: git, this machine, readiness, the merge queue. */
export const layerNightShiftPorts = Layer.mergeAll(
  NightShiftGit.layer,
  layerMachine,
  layerProviders,
  layerMergeQueueUnset,
  KeepAwake.layer,
);

/** The runner, its claim and its ports; one instance per server. */
export const layerNightShiftRunner = layerClaim.pipe(
  Layer.provideMerge(Runner.layer),
  Layer.provideMerge(Threads.layer),
  Layer.provideMerge(layerNightShiftPorts),
);

/** The service over the runner above, and the catch-up the server runs once on start. */
export const layerNightShift = Layer.mergeAll(Service.layer, layerCatchUp);

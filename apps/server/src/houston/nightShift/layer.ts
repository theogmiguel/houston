// Night shift as the server composes it: the runner with its ports and crew gate, the claim
// upstream's scheduled tasks ask, landing, and the RPC service with the catch-up of a missed night.
import * as Layer from "effect/Layer";

import * as CrewGate from "./CrewGate.ts";
import * as NightShiftGit from "./Git.ts";
import {
  layerBacklog,
  layerMachine,
  layerMergeQueue,
  layerProviders,
  layerPullRequests,
} from "./Host.ts";
import * as KeepAwake from "./KeepAwake.ts";
import * as Landing from "./landing/Landing.ts";
import { layerCi, layerLandingQueue } from "./landing/Ports.ts";
import * as Runner from "./Runner.ts";
import { layerCatchUp, layerClaim } from "./ScheduledTaskRunner.ts";
import * as Service from "./Service.ts";
import * as Threads from "./Threads.ts";

/** The ports the runner and the service read: git, this machine, readiness, tasks, GitHub. */
export const layerNightShiftPorts = Layer.mergeAll(
  layerMachine,
  layerProviders,
  layerMergeQueue,
  layerBacklog,
  layerPullRequests,
  KeepAwake.layer,
).pipe(Layer.provideMerge(NightShiftGit.layer));

/** The runner, its claim, its ports and the crew gate the delegation tools ask; one per server. */
export const layerNightShiftRunner = layerClaim.pipe(
  Layer.provideMerge(Runner.layer),
  Layer.provideMerge(CrewGate.layer),
  Layer.provideMerge(Threads.layer),
  Layer.provideMerge(layerNightShiftPorts),
);

/** Landing over the merge queue, upstream's GitHubRest and pull request service, and git. */
export const layerNightLanding = Landing.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(layerCi, layerLandingQueue)),
);

/** The service and landing over the runner above, and the catch-up the server runs on start. */
export const layerNightShift = Layer.mergeAll(Service.layer, layerCatchUp).pipe(
  Layer.provideMerge(layerNightLanding),
);

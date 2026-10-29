import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

// Houston has no telemetry service: relay and cloud spans stay on the local tracer, so no
// export URL, dataset or token from the environment or the build reaches a remote endpoint.
export const layer = Layer.succeed(RelayClientTracer, Option.none());

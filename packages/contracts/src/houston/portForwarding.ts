import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "../baseSchemas.ts";

/**
 * The authenticated WebSocket a desktop host uses to carry one TCP connection
 * through a linked environment. The endpoint dials loopback on that
 * environment; it never listens for the forwarded service.
 */
export const PORT_FORWARD_TUNNEL_PATH = "/api/port-forward/ws";
export const PORT_FORWARD_TUNNEL_PORT_PARAM = "port";

/** Bounds keep one machine from exhausting its descriptors or the environment's sockets. */
export const PORT_FORWARDING_MAX_FORWARDS = 16;
export const PORT_FORWARDING_MAX_FORWARDS_PER_ENVIRONMENT = 8;
export const PORT_FORWARDING_MAX_CONNECTIONS_PER_FORWARD = 8;
export const PORT_FORWARDING_MAX_TUNNELS = 32;
/** How many ports after the remote port are tried before the forward is refused. */
export const PORT_FORWARDING_LOCAL_PORT_WINDOW = 50;

export const PORT_FORWARDING_MIN_PORT = 1;
export const PORT_FORWARDING_MAX_PORT = 65_535;

export const PortForwardingPort = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(PORT_FORWARDING_MIN_PORT),
).check(Schema.isLessThanOrEqualTo(PORT_FORWARDING_MAX_PORT));
export type PortForwardingPort = typeof PortForwardingPort.Type;

export const PortForwardTransport = Schema.Literals(["ssh", "linked"]);
export type PortForwardTransport = typeof PortForwardTransport.Type;

export const PortForwardState = Schema.Literals(["active", "failed"]);
export type PortForwardState = typeof PortForwardState.Type;

/** One forward this device holds, as the Ports list shows it. */
export const PortForward = Schema.Struct({
  id: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  environmentLabel: TrimmedNonEmptyString,
  transport: PortForwardTransport,
  remotePort: PortForwardingPort,
  localPort: PortForwardingPort,
  state: PortForwardState,
  error: Schema.NullOr(TrimmedNonEmptyString),
});
export type PortForward = typeof PortForward.Type;

export const PortForwardStartInput = Schema.Struct({
  environmentId: EnvironmentId,
  remotePort: PortForwardingPort,
});
export type PortForwardStartInput = typeof PortForwardStartInput.Type;

export const PortForwardStopInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type PortForwardStopInput = typeof PortForwardStopInput.Type;

export const PortForwardingReason = Schema.Literals([
  "disabled",
  "unsupported-environment",
  "unknown-environment",
  "missing-credential",
  "local-port-unavailable",
  "forward-limit",
  "connection-limit",
  "transport-failed",
]);
export type PortForwardingReason = typeof PortForwardingReason.Type;

export class PortForwardingError extends Schema.TaggedError<PortForwardingError>()(
  "PortForwardingError",
  {
    reason: PortForwardingReason,
    message: Schema.String,
  },
) {}

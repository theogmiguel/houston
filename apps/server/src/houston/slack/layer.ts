// The Slack intake over the Tasks services and its store. `adapters` provides the Web API client
// and the socket transport: the server passes the live ones, tests the loopback fake's.
import * as Layer from "effect/Layer";

import * as Connection from "./Connection.ts";
import * as Intake from "./Intake.ts";
import * as Outbox from "./Outbox.ts";
import * as Replies from "./Replies.ts";
import * as Service from "./Service.ts";
import type { SlackWebApi } from "./WebApi.ts";

export const layerSlack = <E, R>(
  adapters: Layer.Layer<SlackWebApi | Connection.SlackSocketTransport, E, R>,
) =>
  Service.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Outbox.layer, Replies.layer)),
    Layer.provideMerge(Connection.layer),
    Layer.provideMerge(Intake.layer),
    Layer.provideMerge(adapters),
  );

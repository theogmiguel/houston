// The Slack intake over the Tasks services and its store. `adapters` provides the Web API client,
// the socket transport and the answer delivery: the server passes the live ones, tests fakes.
import * as Layer from "effect/Layer";

import * as Connection from "./Connection.ts";
import * as Conversation from "./Conversation.ts";
import * as Intake from "./Intake.ts";
import * as Outbox from "./Outbox.ts";
import * as Replies from "./Replies.ts";
import type { HoustonSlackRunMessages } from "./RunMessages.ts";
import * as Service from "./Service.ts";
import * as V1Import from "./V1Import.ts";
import type { SlackWebApi } from "./WebApi.ts";

export const layerSlack = <E, R>(
  adapters: Layer.Layer<
    SlackWebApi | Connection.SlackSocketTransport | HoustonSlackRunMessages,
    E,
    R
  >,
) =>
  Service.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Outbox.layer, Replies.layer, V1Import.layer)),
    Layer.provideMerge(Connection.layer),
    Layer.provideMerge(Intake.layer),
    Layer.provideMerge(Conversation.layer),
    Layer.provideMerge(adapters),
  );

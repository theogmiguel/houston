import { ConnectionCatalogDocument } from "@houston-app/client-runtime/platform";
import type { EnvironmentId } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConnectionCatalogStore from "../../app/DesktopConnectionCatalogStore.ts";
import * as DesktopPortForwarding from "../../portForwarding/DesktopPortForwarding.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.connectionCatalog.get")(function* () {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    return Option.getOrNull(yield* store.get);
  }),
});

const decodeCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(ConnectionCatalogDocument));

const retainedEnvironments = (raw: string | null): ReadonlySet<EnvironmentId> => {
  if (raw === null) return new Set();
  const decoded = decodeCatalog(raw);
  if (Option.isNone(decoded)) return new Set();
  return new Set([
    ...decoded.value.targets.map((target) => target.environmentId),
    ...decoded.value.disabledEnvironmentIds,
  ]);
};

export const setConnectionCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CONNECTION_CATALOG_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.connectionCatalog.set")(function* (catalog) {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    const previous = Option.getOrNull(yield* store.get);
    const saved = yield* store.set(catalog);
    if (saved) {
      const retained = retainedEnvironments(catalog);
      const forwarding = yield* DesktopPortForwarding.DesktopPortForwarding;
      yield* Effect.forEach(
        [...retainedEnvironments(previous)].filter((id) => !retained.has(id)),
        (environmentId) => forwarding.stopEnvironment(environmentId),
        { discard: true },
      );
    }
    return saved;
  }),
});

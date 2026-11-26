import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes, PeerLinkError } from "@houston-app/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
} from "../peer/PeerLinks.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import { layerNoWorkspaces } from "./workspaceToolkit/workspaceToolkit.testkit.ts";
import * as PeerLinkPairing from "./peerLinkPairing.ts";

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");

const serveBox = () =>
  servePeer(
    box,
    McpHttpServer.layerEnvironmentToolkit.pipe(
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "houston-peer-pairing-box-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provide(NodeServices.layer),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(box.environmentId),
          getDescriptor: Effect.succeed(box),
        }),
      ),
      Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
      Layer.provide(Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({})),
      Layer.provide(layerNoWorkspaces),
    ),
  );

const makeLaptop = () => Effect.gen(function* () {
  const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
  const layerPairing = PeerLinkPairing.layer.pipe(
    Layer.provide(PeerForwarding.layer),
    Layer.provide(Layer.succeedContext(linking)),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(null),
      }),
    ),
  );
  const pairing = Context.get(
    yield* Layer.build(Layer.fresh(layerPairing)),
    PeerLinkPairing.PeerLinkPairing,
  );
  return {
    links: Context.get(linking, PeerLinks.PeerLinks),
    settings: Context.get(linking, ServerSettings.ServerSettingsService),
    sql: Context.get(linking, SqlClient.SqlClient),
    pairing,
  };
});

const scopes = [...AuthStandardClientScopes];
const caller = { scopes, clientLabel: "Laptop window" };

it.effect("a full-access link gets one client pairing, with only standard client scopes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox();
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "full-access");

      const result = yield* a.pairing.pairClient({ environmentId: box.environmentId }, caller);

      expect(result).toMatchObject({
        environmentId: box.environmentId,
        label: "Box",
        host: new URL(b.url).host,
      });
      expect(result.credential.length).toBeGreaterThan(0);
      expect(result.expiresAt.length).toBeGreaterThan(0);
      // The linked environment records where it came from, so it can be revoked there.
      expect(yield* b.auth.listPairingLinks()).toMatchObject([
        { label: "Laptop window · via Laptop", permissions: AuthStandardClientScopes },
      ]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses a link below full access, naming required and actual access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox();
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "approval-required");
      yield* Ref.set(b.bearers, []);

      const error = yield* Effect.flip(
        a.pairing.pairClient({ environmentId: box.environmentId }, caller),
      );
      expect(error).toBeInstanceOf(PeerLinkError);
      expect(error.reason).toBe("pairing_rejected");
      expect(error.message).toContain("full-access");
      expect(error.message).toContain("approval required");
      // Refused here, before anything reached the linked machine.
      expect(yield* Ref.get(b.bearers)).toEqual([]);
      expect(yield* b.auth.listPairingLinks()).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("sends nothing while Linked environments is off here", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox();
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "full-access");
      yield* a.settings.updateSettings({ linkedEnvironmentsEnabled: false });
      yield* Ref.set(b.bearers, []);
      yield* Ref.set(b.probes, 0);

      const error = yield* Effect.flip(
        a.pairing.pairClient({ environmentId: box.environmentId }, caller),
      );
      expect(error.reason).toBe("disabled");
      expect(yield* Ref.get(b.bearers)).toEqual([]);
      expect(yield* Ref.get(b.probes)).toBe(0);
      expect(yield* b.auth.listPairingLinks()).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.live("an expired link's error never carries a code it issued before", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox();
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "full-access");
      const issued = yield* a.pairing.pairClient({ environmentId: box.environmentId }, caller);
      yield* a.sql`UPDATE peer_environment_links SET expires_at = '2020-01-01T00:00:00.000Z'`;

      const error = yield* Effect.flip(
        a.pairing.pairClient({ environmentId: box.environmentId }, caller),
      );
      expect(error.reason).toBe("expired");
      expect(error.message).not.toContain(issued.credential);
      expect(String(error)).not.toContain(issued.credential);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

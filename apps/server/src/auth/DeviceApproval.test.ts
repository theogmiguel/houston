import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthGrantScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  authScopeResponse,
  ServerSettingsError,
} from "@houston-app/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const requestMetadata = {
  deviceType: "mobile" as const,
  os: "Android",
  browser: "Chrome",
  ipAddress: "192.168.1.40",
};

const layerServerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.map(ServerConfig.ServerConfig, (config) => ({ ...config, port: 13_774 })),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "houston-device-approval-" })),
);

const layerEnvironmentAuth = (requireApprovalForNewDevices: boolean) =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(ServerSettings.layerTest({ requireApprovalForNewDevices })),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerServerConfig),
  );

// Settings that cannot be read must not open the gate: pairing then waits for the owner.
const layerUnreadableSettings = Layer.effect(
  ServerSettings.ServerSettingsService,
  Effect.map(ServerSettings.ServerSettingsService, (service) => ({
    ...service,
    getSettings: Effect.fail(
      new ServerSettingsError({
        settingsPath: "<memory>",
        operation: "normalize",
        cause: "the settings file could not be read",
      }),
    ),
  })),
).pipe(Layer.provide(ServerSettings.layerTest({ requireApprovalForNewDevices: false })));

const layerEnvironmentAuthUnreadableSettings = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(layerUnreadableSettings),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerServerConfig),
);

const makeCookieRequest = (
  cookieName: string,
  sessionToken: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0] =>
  ({
    cookies: { [cookieName]: sessionToken },
    headers: {},
  }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

const pairDevice = (
  serverAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  input?: {
    readonly scopes?: ReadonlyArray<AuthGrantScope>;
    readonly label?: string;
  },
) =>
  Effect.gen(function* () {
    const pairing = yield* serverAuth.issuePairingCredential({
      ...(input?.label ? { label: input.label } : {}),
      scopes: input?.scopes ?? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    });
    return yield* serverAuth.createBrowserSession(pairing.credential, requestMetadata, undefined, {
      pairedVia: "pairing-link",
    });
  });

it.layer(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer))("device approval", (it) => {
  it.effect("pairs immediately while the setting is off", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const paired = yield* pairDevice(serverAuth);
      const session = yield* sessions.verify(paired.sessionToken);

      expect(paired.response).toMatchObject(
        authScopeResponse([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
      );
      expect(yield* serverAuth.listPendingDevices()).toEqual([]);
      expect(
        (yield* serverAuth.listClientSessions(session.sessionId)).map((client) => client.scopes),
      ).toEqual([[AuthOrchestrationReadScope, AuthOrchestrationOperateScope]]);
    }).pipe(Effect.provide(layerEnvironmentAuth(false))),
  );

  it.effect("holds a new device pending when the setting cannot be read", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const paired = yield* pairDevice(serverAuth);
      const session = yield* sessions.verify(paired.sessionToken);

      expect(session.scopes).toEqual([]);
      expect(yield* serverAuth.listPendingDevices()).toHaveLength(1);
    }).pipe(Effect.provide(layerEnvironmentAuthUnreadableSettings)),
  );

  it.effect("holds a new device pending with no scope and names it in the refusal", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const paired = yield* pairDevice(serverAuth, { label: "Living room iPad" });
      const session = yield* sessions.verify(paired.sessionToken);

      expect(paired.response.permissions).toEqual([]);
      expect(paired.response.approvalPending).toMatchObject({
        deviceName: "Living room iPad",
        hostLabel: "this host",
        limitHours: 24,
      });
      expect(yield* serverAuth.listClientSessions(session.sessionId)).toEqual([]);
      expect((yield* serverAuth.listPendingDevices())[0]).toMatchObject({
        sessionId: session.sessionId,
        deviceName: "Living room iPad",
        pairedVia: "pairing-link",
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      });

      const request = makeCookieRequest(sessions.cookieName, paired.sessionToken);
      const error = yield* serverAuth.authenticateHttpRequest(request).pipe(Effect.flip);
      expect(error._tag).toBe("ServerAuthDeviceApprovalPendingError");
      expect(error.message).toContain("Living room iPad");
      expect(error.message).toContain("Require approval for new devices");
      expect(error.message).toContain("24 hours");
    }).pipe(Effect.provide(layerEnvironmentAuth(true))),
  );

  it.effect("approving grants exactly the pairing scopes and moves the device to clients", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const paired = yield* pairDevice(serverAuth, {
        scopes: [AuthOrchestrationReadScope],
        label: "Kitchen phone",
      });
      const [pending] = yield* serverAuth.listPendingDevices();
      expect(yield* serverAuth.approvePendingDevice(pending!.sessionId)).toBe(true);

      const request = makeCookieRequest(sessions.cookieName, paired.sessionToken);
      const authenticated = yield* serverAuth.authenticateHttpRequest(request);
      expect(authenticated.scopes).toEqual([AuthOrchestrationReadScope]);
      expect(yield* serverAuth.listPendingDevices()).toEqual([]);
      expect(
        (yield* serverAuth.listClientSessions(authenticated.sessionId)).map(
          (client) => client.scopes,
        ),
      ).toEqual([[AuthOrchestrationReadScope]]);
    }).pipe(Effect.provide(layerEnvironmentAuth(true))),
  );

  it.effect("keeps the pending state in a Houston table and leaves auth_sessions as it was", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sql = yield* SqlClient.SqlClient;
      yield* pairDevice(serverAuth);

      const columns = (yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`).map(
        (column) => column.name,
      );
      expect(columns.filter((name) => name.startsWith("pending_"))).toEqual([]);
      const held = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM houston_pending_device_approvals
      `;
      expect(held[0]?.count).toBe(1);

      const [pending] = yield* serverAuth.listPendingDevices();
      yield* serverAuth.approvePendingDevice(pending!.sessionId);
      const after = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM houston_pending_device_approvals
      `;
      expect(after[0]?.count).toBe(0);
    }).pipe(Effect.provide(layerEnvironmentAuth(true))),
  );

  it.effect("ends a connected pending device's session when the owner approves it", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const paired = yield* pairDevice(serverAuth);
      const verified = yield* sessions.verify(paired.sessionToken);
      const waiting = yield* sessions.awaitInvalidation(verified.sessionId).pipe(Effect.forkChild);
      // Let the wait subscribe before the owner decides.
      for (let tick = 0; tick < 20; tick += 1) yield* Effect.yieldNow;

      const [pending] = yield* serverAuth.listPendingDevices();
      yield* serverAuth.approvePendingDevice(pending!.sessionId);

      // The socket closes so the device reconnects holding the scopes it now has.
      yield* Fiber.join(waiting);
    }).pipe(Effect.provide(layerEnvironmentAuth(true))),
  );

  it.effect("denying revokes the credential", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const paired = yield* pairDevice(serverAuth);
      const [pending] = yield* serverAuth.listPendingDevices();
      expect(yield* serverAuth.denyPendingDevice(pending!.sessionId)).toBe(true);
      expect(yield* serverAuth.listPendingDevices()).toEqual([]);

      const error = yield* serverAuth
        .authenticateHttpRequest(makeCookieRequest(sessions.cookieName, paired.sessionToken))
        .pipe(Effect.flip);
      expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(Effect.provide(layerEnvironmentAuth(true))),
  );

  it.effect("expires an undecided device and refuses its credential", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const now = yield* DateTime.now;
      const issued = yield* sessions.issue({
        subject: "one-time-token",
        scopes: [],
        pendingApproval: {
          grantedScopes: [AuthOrchestrationReadScope],
          pairedVia: "pairing-code",
          expiresAt: DateTime.subtract(DateTime.toUtc(now), { hours: 1 }),
        },
        client: requestMetadata,
      });

      const error = yield* sessions.verify(issued.token).pipe(Effect.flip);
      expect(error._tag).toBe("SessionPendingApprovalExpiredError");
      expect(yield* serverAuth.listPendingDevices()).toEqual([]);
    }).pipe(Effect.provide(layerEnvironmentAuth(true))),
  );

  it.effect("turning the setting off leaves waiting devices waiting", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* pairDevice(serverAuth, { label: "Hallway tablet" });
      expect(yield* serverAuth.listPendingDevices()).toHaveLength(1);

      yield* settings.updateSettings({ requireApprovalForNewDevices: false });
      expect(yield* serverAuth.listPendingDevices()).toHaveLength(1);

      const pairedAfter = yield* pairDevice(serverAuth, { label: "Office laptop" });
      expect(pairedAfter.response.permissions).toEqual([
        AuthOrchestrationReadScope,
        AuthOrchestrationOperateScope,
      ]);
    }).pipe(Effect.provide(layerEnvironmentAuth(true))),
  );
});

it.layer(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer))(
  "pending approval persistence",
  (it) => {
    it.effect("keeps a pending device across a database reopen", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-pending-device-" });
        const file = path.join(dir, "state.sqlite");
        const now = yield* DateTime.now;
        const input = {
          sessionId: "pending-device-restart" as AuthSessions.CreateAuthSessionInput["sessionId"],
          subject: "one-time-token",
          scopes: [],
          method: "browser-session-cookie" as const,
          client: {
            label: "Back porch phone",
            ipAddress: null,
            userAgent: null,
            deviceType: "mobile" as const,
            os: "Android",
            browser: "Chrome",
          },
          issuedAt: now,
          expiresAt: DateTime.add(now, { days: 1 }),
          pendingApproval: {
            grantedScopes: [AuthOrchestrationReadScope],
            pairedVia: "pairing-code" as const,
            expiresAt: DateTime.add(now, { hours: 24 }),
          },
        };

        yield* Effect.gen(function* () {
          const repository = yield* AuthSessions.AuthSessionRepository;
          yield* repository.create(input);
        }).pipe(
          Effect.provide(
            Layer.fresh(AuthSessions.layer).pipe(
              Layer.provideMerge(SqlitePersistence.layerFromPath(file)),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const repository = yield* AuthSessions.AuthSessionRepository;
          const pending = yield* repository.listPending({ now });
          expect(pending).toHaveLength(1);
          expect(pending[0]).toMatchObject({
            sessionId: input.sessionId,
            pendingApproval: {
              grantedScopes: [AuthOrchestrationReadScope],
              pairedVia: "pairing-code",
            },
          });
        }).pipe(
          Effect.provide(
            Layer.fresh(AuthSessions.layer).pipe(
              Layer.provideMerge(SqlitePersistence.layerFromPath(file)),
            ),
          ),
        );
      }),
    );
  },
);

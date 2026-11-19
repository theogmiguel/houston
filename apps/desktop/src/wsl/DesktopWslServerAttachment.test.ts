import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBootstrapSecret from "../backend/DesktopBootstrapSecret.ts";
import * as DesktopWslEnvironment from "./DesktopWslEnvironment.ts";
import * as DesktopWslServerAttachment from "./DesktopWslServerAttachment.ts";

const SECRET = "a".repeat(64);
const RECORD_PATH = "/home/ubuntu/.houston/v2/userdata/server-runtime.json";

const runtimeRecord = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  pid: 4242,
  host: "0.0.0.0",
  port: 3773,
  origin: "http://127.0.0.1:3773",
  startedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const environmentLayer = (channel: Option.Option<string>, devServerUrl: Option.Option<URL>) =>
  Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
    channel,
    devServerUrl,
    backendEntryPath: "/app/apps/server/dist/bin.mjs",
    backendCwd: "/app",
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

const secretLayer = Layer.succeed(
  DesktopBootstrapSecret.DesktopBootstrapSecret,
  DesktopBootstrapSecret.DesktopBootstrapSecret.of({
    resolve: Effect.succeed({ secret: SECRET, warning: Option.none() }),
  }),
);

const httpLayer = (input: { readonly healthStatus?: number; readonly authStatus?: number }) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/oauth/token") {
        const status = input.authStatus ?? 200;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              status === 200
                ? {
                    access_token: "bearer-token",
                    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "orchestration:read",
                  }
                : { error: "invalid_grant", error_description: "bad credential" },
              { status },
            ),
          ),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(null, { status: input.healthStatus ?? 200 }),
        ),
      );
    }),
  );

const runResolve = (input: {
  readonly record?: Record<string, unknown>;
  readonly recordRead?: DesktopWslEnvironment.WslRuntimeRecordReadResult;
  readonly processAlive?: boolean;
  readonly healthStatus?: number;
  readonly authStatus?: number;
  readonly channel?: Option.Option<string>;
  readonly devServerUrl?: Option.Option<URL>;
  readonly distro?: string | null;
}) => {
  const recordRead =
    input.recordRead ??
    ({
      _tag: "Record",
      contents: `${JSON.stringify(runtimeRecord(input.record))}\n`,
    } as const);
  const wslLayer = DesktopWslEnvironment.layerTest({
    isAvailable: true,
    getUserHome: () => ({ ok: true, home: "/home/ubuntu" }),
    getDistroIp: () => Option.some("192.0.2.2"),
    readServerRuntimeRecord: () => recordRead,
    isProcessAlive: () => input.processAlive ?? true,
  });
  return DesktopWslServerAttachment.DesktopWslServerAttachment.use((service) =>
    service.resolve({ distro: input.distro === undefined ? "Ubuntu" : input.distro }),
  ).pipe(
    Effect.provide(
      DesktopWslServerAttachment.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            environmentLayer(input.channel ?? Option.none(), input.devServerUrl ?? Option.none()),
            secretLayer,
            wslLayer,
            httpLayer({
              ...(input.healthStatus === undefined ? {} : { healthStatus: input.healthStatus }),
              ...(input.authStatus === undefined ? {} : { authStatus: input.authStatus }),
            }),
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );
};

describe("DesktopWslServerAttachment", () => {
  it.effect("attaches to a healthy server named by the distro's runtime record", () =>
    Effect.gen(function* () {
      const result = yield* runResolve({});

      assert.strictEqual(result._tag, "Attached");
      if (result._tag !== "Attached") return;
      assert.equal(result.attachment.pid, 4242);
      assert.equal(result.attachment.httpBaseUrl.hostname, "192.0.2.2");
      assert.equal(result.attachment.httpBaseUrl.port, "3773");
      assert.equal(result.attachment.config.bootstrap.houstonHome, "/home/ubuntu/.houston/v2");
      assert.equal(result.attachment.config.bootstrap.port, 3773);
      assert.equal(result.attachment.config.bootstrap.desktopBootstrapSecret, SECRET);
      assert.isString(result.attachment.config.bootstrap.desktopBootstrapToken);
      assert.equal(result.attachment.config.runningDistro, "Ubuntu");
    }),
  );

  it.effect("reports no record when the distro has none, so a normal start proceeds", () =>
    Effect.gen(function* () {
      const result = yield* runResolve({ recordRead: { _tag: "Missing" } });

      assert.deepStrictEqual(result, { _tag: "NoRecord", recordPath: RECORD_PATH });
    }),
  );

  it.effect(
    "names the distro and PID when the recorded server does not answer its health check",
    () =>
      Effect.gen(function* () {
        const result = yield* runResolve({ healthStatus: 503 });

        assert.strictEqual(result._tag, "Unavailable");
        if (result._tag !== "Unavailable") return;
        assert.include(result.reason, "WSL distro Ubuntu");
        assert.include(result.reason, "PID 4242");
        assert.equal(result.pid, 4242);
      }),
  );

  it.effect("reports a credential the server rejects instead of attaching forever", () =>
    Effect.gen(function* () {
      const result = yield* runResolve({ authStatus: 400 });

      assert.strictEqual(result._tag, "Unavailable");
      if (result._tag !== "Unavailable") return;
      assert.include(result.reason, "WSL distro Ubuntu");
      assert.include(result.reason, "PID 4242");
      assert.include(result.reason, "desktop credential");
    }),
  );

  it.effect("uses the channel's state directory in the distro", () =>
    Effect.gen(function* () {
      let seenPath = "";
      const wslLayer = DesktopWslEnvironment.layerTest({
        isAvailable: true,
        getUserHome: () => ({ ok: true, home: "/home/ubuntu" }),
        getDistroIp: () => Option.some("192.0.2.2"),
        readServerRuntimeRecord: (_distro, recordPath) => {
          seenPath = recordPath;
          return { _tag: "Missing" };
        },
      });
      yield* DesktopWslServerAttachment.DesktopWslServerAttachment.use((service) =>
        service.resolve({ distro: "Ubuntu" }),
      ).pipe(
        Effect.provide(
          DesktopWslServerAttachment.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                environmentLayer(Option.some("dev"), Option.none()),
                secretLayer,
                wslLayer,
                httpLayer({}),
                NodeCrypto.layer,
              ),
            ),
          ),
        ),
      );

      assert.equal(seenPath, "/home/ubuntu/.houston-dev/v2/userdata/server-runtime.json");
    }),
  );

  it.effect("looks in dev/ when the desktop passes a development URL", () =>
    Effect.gen(function* () {
      let seenPath = "";
      const wslLayer = DesktopWslEnvironment.layerTest({
        isAvailable: true,
        getUserHome: () => ({ ok: true, home: "/home/ubuntu" }),
        getDistroIp: () => Option.some("192.0.2.2"),
        readServerRuntimeRecord: (_distro, recordPath) => {
          seenPath = recordPath;
          return { _tag: "Missing" };
        },
      });
      yield* DesktopWslServerAttachment.DesktopWslServerAttachment.use((service) =>
        service.resolve({ distro: "Ubuntu" }),
      ).pipe(
        Effect.provide(
          DesktopWslServerAttachment.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                environmentLayer(Option.none(), Option.some(new URL("http://localhost:5173"))),
                secretLayer,
                wslLayer,
                httpLayer({}),
                NodeCrypto.layer,
              ),
            ),
          ),
        ),
      );

      assert.equal(seenPath, "/home/ubuntu/.houston/v2/dev/server-runtime.json");
    }),
  );
});

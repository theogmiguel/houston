<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
=======
// T3 ingest retains events and forwards to PostHog; UUIDs deduplicate retries there.
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { ClientOs } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
/** The account a recorded event belongs to. */
export type TelemetryOwnerSource = "connect" | "openai" | "claude" | "device";
=======
import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { getTelemetryIdentity, type TelemetryOwner } from "./Identify.ts";
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb

export interface TelemetryOwner {
  readonly source: TelemetryOwnerSource;
  /** `hashTelemetryId` of the source's raw id. */
  readonly ownerId: string;
}

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    readonly flush: Effect.Effect<void>;

    readonly recordOwners: (
      owners: ReadonlyArray<TelemetryOwner>,
      observedBy: "server" | "client",
    ) => Effect.Effect<void>;
  }
<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
>()("houston/telemetry/AnalyticsService") {}
=======
>()("t3/telemetry/AnalyticsService") {}

function serverOsFromNodePlatform(platform: string): ClientOs {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "android":
      return "Android";
    default:
      return "other";
  }
}

/** @public */
/** @public */
export const make = Effect.gen(function* () {
  const telemetryConfig = yield* TelemetryEnvConfig;
  const hostEnvironment = yield* HostProcess.Environment;
  const awaitingShellConsent = hostEnvironment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING === "1";
  // A managed policy can switch analytics off over the environment, never on.
  const policyAllows =
    ManagedPolicy.deniedBy(yield* ManagedPolicy.ManagedPolicy, "telemetry") === undefined;
  // A cached PATH does not establish consent from the current login shell.
  const telemetryEnabled = Effect.suspend(() => {
    if (!telemetryConfig.enabled || !policyAllows) return Effect.succeed(false);
    if (!awaitingShellConsent) return Effect.succeed(true);
    if (hostEnvironment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING === "1")
      return Effect.succeed(false);
    const preference = hostEnvironment.T3CODE_TELEMETRY_ENABLED;
    return Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(
      Config.withDefault(true),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: preference === undefined ? {} : { T3CODE_TELEMETRY_ENABLED: preference },
        }),
      ),
      Effect.orElseSucceed(() => false),
    );
  });
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const { distinctId, installId } = yield* getTelemetryIdentity;
  const crypto = yield* Crypto.Crypto;
  const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
  const deliveryRef = yield* Ref.make<DeliveryState>({
    failedBatch: [],
    batchAttempts: 0,
    firstFailedAt: 0,
    failures: 0,
    retryAt: 0,
  });
  const recordedOwnersRef = yield* Ref.make<
    Readonly<Record<"server" | "client", ReadonlySet<string>>>
  >({ server: new Set(), client: new Set() });
  // The background flush and the shutdown flush must not send the same batch at once.
  const flushLock = yield* Semaphore.make(1);
  const clientType = serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client";
  const hostPlatform = yield* HostProcess.Platform;
  const hostArchitecture = yield* HostProcess.Architecture;

  const enqueueBufferedEvent = (
    uuid: string,
    event: string,
    properties?: Readonly<Record<string, unknown>>,
  ) =>
    Effect.flatMap(DateTime.now, (now) =>
      Ref.modify(bufferRef, (current) => {
        const appended = [
          ...current,
          {
            uuid,
            event,
            ...(properties ? { properties } : {}),
            capturedAt: DateTime.formatIso(now),
          } satisfies BufferedAnalyticsEvent,
        ];

        const next =
          appended.length > telemetryConfig.maxBufferedEvents
            ? appended.slice(appended.length - telemetryConfig.maxBufferedEvents)
            : appended;

        return [
          {
            size: next.length,
            dropped: next.length !== appended.length,
          } as const,
          next,
        ] as const;
      }),
    );

  const sendBatch = Effect.fn("AnalyticsService.sendBatch")(function* (
    events: ReadonlyArray<BufferedAnalyticsEvent>,
  ) {
    if (!(yield* telemetryEnabled) || !distinctId) return;

    const payload = {
      api_key: telemetryConfig.posthogKey,
      batch: events.map((event) => ({
        uuid: event.uuid,
        event: event.event,
        distinct_id: distinctId,
        properties: {
          ...event.properties,
          ...(installId === null ? {} : { installId }),
          $process_person_profile: false,
          platform: hostPlatform,
          wsl: Option.getOrUndefined(telemetryConfig.wslDistroName),
          arch: hostArchitecture,
          t3CodeVersion: packageJson.version,
          telemetryChannel: ServerConfig.telemetryChannel,
          clientType,
          serverOs: serverOsFromNodePlatform(hostPlatform),
          serverArch: hostArchitecture,
          serverWslDistro: Option.getOrUndefined(telemetryConfig.wslDistroName),
          serverAppVersion: packageJson.version,
          serverMode: serverConfig.mode,
        },
        timestamp: event.capturedAt,
      })),
    };

    yield* HttpClientRequest.post(`${telemetryConfig.posthogHost}/batch/`).pipe(
      HttpClientRequest.bodyJson(payload),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeout(SEND_TIMEOUT),
    );
  });

  const takeBatch = Ref.modify(bufferRef, (current) => {
    const nextBatch = current.slice(0, telemetryConfig.flushBatchSize);
    return [nextBatch, current.slice(nextBatch.length)] as const;
  });

  // Back off even after dropping rejected batches so bad API keys cannot drain the queue in a tight loop.
  const flush: AnalyticsService["Service"]["flush"] = Effect.gen(function* () {
    while (true) {
      const delivery = yield* Ref.get(deliveryRef);
      const batch = delivery.failedBatch.length > 0 ? delivery.failedBatch : yield* takeBatch;
      if (batch.length === 0) {
        return;
      }

      const sent = yield* Effect.result(sendBatch(batch));
      if (Result.isSuccess(sent)) {
        yield* Ref.set(deliveryRef, {
          failedBatch: [],
          batchAttempts: 0,
          firstFailedAt: 0,
          failures: 0,
          retryAt: 0,
        });
        continue;
      }

      const now = yield* Clock.currentTimeMillis;
      const failures = delivery.failures + 1;
      const batchAttempts = delivery.batchAttempts + 1;
      const firstFailedAt = delivery.batchAttempts === 0 ? now : delivery.firstFailedAt;
      const retryAt = now + retryDelayMs(failures, yield* Random.next);
      const error = sent.failure;
      const rejected =
        error._tag === "HttpClientError" &&
        error.reason._tag === "StatusCodeError" &&
        REJECTED_BATCH_STATUSES.has(error.reason.response.status);
      if (!rejected && now - firstFailedAt < MAX_BATCH_RETRY_MS) {
        yield* Ref.set(deliveryRef, {
          failedBatch: batch,
          batchAttempts,
          firstFailedAt,
          failures,
          retryAt,
        });
        yield* Effect.logDebug("Failed to send telemetry batch; will retry", {
          attempt: batchAttempts,
          cause: error,
        });
        return;
      }
      yield* Ref.set(deliveryRef, {
        failedBatch: [],
        batchAttempts: 0,
        firstFailedAt: 0,
        failures,
        retryAt,
      });
      yield* Effect.logWarning(
        rejected
          ? "Dropped telemetry batch the endpoint rejected"
          : "Dropped telemetry batch after repeated send failures",
        { events: batch.length, attempts: batchAttempts, cause: error },
      );
      return;
    }
  }).pipe(flushLock.withPermit);

  const flushWhenDue = Effect.gen(function* () {
    const { retryAt } = yield* Ref.get(deliveryRef);
    if ((yield* Clock.currentTimeMillis) >= retryAt) {
      yield* flush;
    }
  });

  const record: AnalyticsService["Service"]["record"] = Effect.fn("AnalyticsService.record")(
    function* (event, properties) {
      if (!(yield* telemetryEnabled) || !distinctId) return;

      // Catch Node UUID defects too; best-effort telemetry drops events without UUIDs.
      const uuid = yield* Effect.exit(crypto.randomUUIDv7());
      if (Exit.isFailure(uuid)) return;

      const enqueueResult = yield* enqueueBufferedEvent(uuid.value, event, properties);
      if (enqueueResult.dropped) {
        yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
          size: enqueueResult.size,
          event,
        });
      }
    },
  );

  const recordOwners: AnalyticsService["Service"]["recordOwners"] = Effect.fn(
    "AnalyticsService.recordOwners",
  )((owners, observedBy) =>
    Effect.forEach(
      owners,
      ({ source, ownerId }) =>
        Ref.modify(recordedOwnersRef, (recorded) => {
          const key = `${source}:${ownerId}`;
          const seen = recorded[observedBy];
          return seen.has(key) || seen.size >= MAX_RECORDED_OWNERS
            ? [false, recorded]
            : [true, { ...recorded, [observedBy]: new Set(seen).add(key) }];
        }).pipe(
          Effect.flatMap((isNew) =>
            isNew
              ? record("install.owner_observed", { ownerSource: source, ownerId, observedBy })
              : Effect.void,
          ),
        ),
      { discard: true },
    ),
  );

  yield* Effect.forever(Effect.sleep(FLUSH_INTERVAL_MS).pipe(Effect.andThen(flushWhenDue)), {
    disableYield: true,
  }).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() => flush);

  return AnalyticsService.of({ record, flush, recordOwners });
});

export const layer = Layer.effect(AnalyticsService, make);
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb

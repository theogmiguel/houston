import type {
  InferenceServerConfig,
  InferenceServerId,
} from "@houston-app/contracts/houston/inference";
import { ProviderInstanceId, ThreadId } from "@houston-app/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

/**
 * Who holds a gateway credential. `pinned` is the server's settings when the credential was
 * minted, so a live request keeps its endpoint even after the server moves or is turned off.
 * A caller without a thread is the environment's own background work.
 */
export interface InferenceCaller {
  readonly serverId: InferenceServerId;
  readonly pinned: InferenceServerConfig;
  readonly threadId?: ThreadId;
  readonly providerSessionId?: string;
  readonly providerInstanceId?: ProviderInstanceId;
}

/** A token for the gateway only; MCP, OAuth and session tokens never resolve here. */
export interface InferenceGatewayCredential {
  readonly serverId: InferenceServerId;
  /** `<origin>/inference/<serverId>/v1` */
  readonly baseUrl: string;
  readonly token: string;
}

export class InferenceGatewayCredentials extends Context.Service<
  InferenceGatewayCredentials,
  {
    /** A credential for one provider session, bound to its thread and its server. */
    readonly issueSession: (input: {
      readonly serverId: InferenceServerId;
      readonly pinned: InferenceServerConfig;
      readonly threadId: ThreadId;
      readonly providerSessionId: string;
      readonly providerInstanceId: ProviderInstanceId;
    }) => Effect.Effect<InferenceGatewayCredential>;
    /** For discovery and text generation; revoked when the scope closes and after a TTL. */
    readonly issueBackground: (input: {
      readonly serverId: InferenceServerId;
      readonly pinned: InferenceServerConfig;
    }) => Effect.Effect<InferenceGatewayCredential, never, Scope.Scope>;
    readonly resolve: (rawToken: string) => Effect.Effect<InferenceCaller | undefined>;
    readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
    readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
    readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly revokeAll: Effect.Effect<void>;
  }
>()("@houston-app/cli/houston/inference/InferenceGatewayCredentials") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly caller: InferenceCaller;
  readonly lastAliveAt: number;
  readonly expiresAt?: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

/** An idle session token stops authenticating; explicit revocation still removes it at once. */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;
/** Discovery and text generation finish well inside this; their scope usually revokes sooner. */
export const BACKGROUND_INFERENCE_TTL_MS = 15 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const getHttpEndpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

export interface InferenceGatewayCredentialsOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
  /** The endpoint a child process can reach; defaults to the listening address. */
  readonly endpoint?: string;
}

const makeWithOptions = Effect.fn("InferenceGatewayCredentials.make")(function* (
  options: InferenceGatewayCredentialsOptions = {},
) {
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const httpServer = yield* Effect.serviceOption(HttpServer.HttpServer);
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const origin =
    options.endpoint ??
    (Option.isSome(httpServer) && NetAddress.isInetAddress(httpServer.value.address)
      ? `http://${getHttpEndpointHost(httpServer.value.address.address)}:${httpServer.value.address.port}`
      : "http://127.0.0.1");

  const gatewayBaseUrl = (serverId: InferenceServerId) =>
    `${origin}/inference/${encodeURIComponent(serverId)}/v1`;

  const hashToken = (token: string) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const mint = Effect.gen(function* () {
    const rawToken = yield* random.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
    return { rawToken, tokenHash: yield* hashToken(rawToken) };
  });

  const store = (record: CredentialRecord) =>
    SynchronizedRef.update(state, ({ records }) => ({
      records: new Map(records).set(record.tokenHash, record),
    }));

  const removeToken = (tokenHash: string) =>
    SynchronizedRef.update(state, ({ records }) => {
      const next = new Map(records);
      next.delete(tokenHash);
      return { records: next };
    });

  const issueSession: InferenceGatewayCredentials["Service"]["issueSession"] = Effect.fn(
    "InferenceGatewayCredentials.issueSession",
  )(function* (input) {
    const issuedAt = yield* currentTimeMillis;
    const minted = yield* mint;
    yield* store({
      tokenHash: minted.tokenHash,
      caller: {
        serverId: input.serverId,
        pinned: input.pinned,
        threadId: input.threadId,
        providerSessionId: input.providerSessionId,
        providerInstanceId: input.providerInstanceId,
      },
      lastAliveAt: issuedAt,
    });
    return {
      serverId: input.serverId,
      baseUrl: gatewayBaseUrl(input.serverId),
      token: minted.rawToken,
    };
  });

  const issueBackground: InferenceGatewayCredentials["Service"]["issueBackground"] = Effect.fn(
    "InferenceGatewayCredentials.issueBackground",
  )(function* (input) {
    const issuedAt = yield* currentTimeMillis;
    const minted = yield* Effect.acquireRelease(mint, ({ tokenHash }) => removeToken(tokenHash));
    yield* store({
      tokenHash: minted.tokenHash,
      caller: { serverId: input.serverId, pinned: input.pinned },
      lastAliveAt: issuedAt,
      expiresAt: issuedAt + BACKGROUND_INFERENCE_TTL_MS,
    });
    return {
      serverId: input.serverId,
      baseUrl: gatewayBaseUrl(input.serverId),
      token: minted.rawToken,
    };
  });

  const resolve: InferenceGatewayCredentials["Service"]["resolve"] = Effect.fn(
    "InferenceGatewayCredentials.resolve",
  )(function* (rawToken) {
    if (rawToken.length === 0) return undefined;
    const tokenHash = yield* hashToken(rawToken);
    const timestamp = yield* currentTimeMillis;
    return yield* SynchronizedRef.modify(state, ({ records }) => {
      const record = records.get(tokenHash);
      if (
        !record ||
        timestamp - record.lastAliveAt > livenessWindowMs ||
        (record.expiresAt !== undefined && timestamp > record.expiresAt)
      ) {
        return [undefined, { records }] as const;
      }
      const next = new Map(records);
      next.set(tokenHash, { ...record, lastAliveAt: timestamp });
      return [record.caller, { records: next }] as const;
    });
  });

  const touch: InferenceGatewayCredentials["Service"]["touch"] = Effect.fn(
    "InferenceGatewayCredentials.touch",
  )(function* (threadId) {
    const timestamp = yield* currentTimeMillis;
    yield* SynchronizedRef.update(state, ({ records }) => {
      const next = new Map(records);
      for (const [tokenHash, record] of records) {
        if (record.caller.threadId === threadId) {
          next.set(tokenHash, { ...record, lastAliveAt: timestamp });
        }
      }
      return { records: next };
    });
  });

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.update(state, ({ records }) => ({
      records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
    }));

  return InferenceGatewayCredentials.of({
    issueSession,
    issueBackground,
    resolve,
    touch,
    revokeProviderSession: Effect.fn("InferenceGatewayCredentials.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.caller.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("InferenceGatewayCredentials.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.caller.threadId === threadId);
    }),
    revokeAll: SynchronizedRef.set(state, { records: new Map() }),
  });
});

export const layer = Layer.effect(InferenceGatewayCredentials, makeWithOptions());

export const __testing = { make: makeWithOptions };

import * as Aead from "effect/crypto/Aead";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/socket/Socket";
import type { NonEmptyReadonlyArray } from "effect/Array";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * Application-layer end-to-end encryption for the WebSocket RPC channel: an
 * Ed25519-signed ephemeral X25519 handshake, HKDF-SHA256 keys, and
 * XChaCha20-Poly1305 records with a strict monotonic counter so tampering,
 * replay and reordering fail the socket. XChaCha20 also runs without crypto.subtle.
 */

/** Query parameter that asks for an E2EE session, mirroring `frameParts`. */
export const SOCKET_E2EE_QUERY_PARAM = "e2ee";

const PROTOCOL_VERSION = 1;
const TRANSCRIPT_PREFIX = "houston-e2ee-v1";
const C2S_INFO = "houston-e2ee-v1-c2s";
const S2C_INFO = "houston-e2ee-v1-s2c";

const KEY_LENGTH = 32;
const NONCE_LENGTH = 32;
const SIGNATURE_LENGTH = 64;
const RECORD_VERSION = 0x01;
const RECORD_COUNTER_LENGTH = 8;
const RECORD_HEADER_LENGTH = 1 + RECORD_COUNTER_LENGTH;
const TAG_LENGTH = 16;
const DIRECTION_C2S = 0x01;
const DIRECTION_S2C = 0x02;
const CLIENT_HELLO_TYPE = 0xc1;
const SERVER_HELLO_TYPE = 0xc2;
/** Nonce for XChaCha20-Poly1305: a zero prefix followed by the record counter. */
const NONCE_PREFIX_LENGTH = 16;
/** Rekeying is out of scope for v1; close long before the counter space thins. */
const MAX_RECORD_COUNTER = 2 ** 32 - 1;
export const E2EE_HANDSHAKE_TIMEOUT = "15 seconds";

export const E2EE_IDENTITY_MISMATCH_CODE = "E2EE_IDENTITY_MISMATCH";
export const E2EE_REQUIRED_CODE = "E2EE_REQUIRED";

export class E2eeProtocolError extends Schema.TaggedError<E2eeProtocolError>()(
  "E2eeProtocolError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** The server identity key differs from the pinned one: a re-paired server, or a MITM. */
export class E2eeIdentityMismatchError extends Schema.TaggedError<E2eeIdentityMismatchError>()(
  "E2eeIdentityMismatchError",
  {
    pinnedFingerprint: Schema.String,
    receivedFingerprint: Schema.String,
  },
) {
  override get message(): string {
    return `${E2EE_IDENTITY_MISMATCH_CODE}: the server's identity key changed from ${this.pinnedFingerprint} to ${this.receivedFingerprint}.`;
  }
}

export type E2eeHandshakeError = E2eeProtocolError | E2eeIdentityMismatchError;

const isIdentityMismatchError = Schema.is(E2eeIdentityMismatchError);
const isProtocolError = Schema.is(E2eeProtocolError);

/** The service shape the wrappers run their records against. */
type AeadService = Aead.Aead["Service"];

const FINGERPRINT_GROUPS = /.{4}/g;

const concatBytes = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const bigEndianCounter = (counter: number): Uint8Array => {
  const bytes = new Uint8Array(RECORD_COUNTER_LENGTH);
  let value = counter;
  for (let index = RECORD_COUNTER_LENGTH - 1; index >= 0; index -= 1) {
    bytes[index] = value % 256;
    value = Math.floor(value / 256);
  }
  return bytes;
};

const readBigEndianCounter = (bytes: Uint8Array, offset: number): number => {
  let value = 0;
  for (let index = 0; index < RECORD_COUNTER_LENGTH; index += 1) {
    value = value * 256 + (bytes[offset + index] ?? 0);
  }
  return value;
};

/** Length-prefix an environment id so the transcript framing is unambiguous. */
const lengthPrefixed = (value: string): Uint8Array => {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length > 0xffff) {
    throw new E2eeProtocolError({ detail: "Environment id is too long for the E2EE transcript." });
  }
  return concatBytes(new Uint8Array([encoded.length >> 8, encoded.length & 0xff]), encoded);
};

const timingSafeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};

export interface E2eeIdentityKeypair {
  readonly seed: Uint8Array;
  readonly publicKey: Uint8Array;
}

export const identityPublicKeyFromSeed = (seed: Uint8Array): Uint8Array => {
  if (seed.length !== KEY_LENGTH) {
    throw new E2eeProtocolError({ detail: "The Ed25519 identity seed must be 32 bytes." });
  }
  return ed25519.getPublicKey(seed);
};

export const generateIdentityKeypair = Effect.fn("socketE2ee.generateIdentityKeypair")(
  function* () {
    const random = yield* SecureRandom.SecureRandom;
    const seed = yield* random.randomBytes(KEY_LENGTH);
    return {
      seed: Uint8Array.from(seed),
      publicKey: identityPublicKeyFromSeed(Uint8Array.from(seed)),
    } satisfies E2eeIdentityKeypair;
  },
);

/** `XXXX-XXXX-XXXX-XXXX` over the first 8 bytes of SHA-256 of the public key. */
export const identityFingerprint = (publicKey: Uint8Array): string => {
  const digest = sha256(publicKey).slice(0, 8);
  return (
    Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .match(FINGERPRINT_GROUPS) ?? []
  )
    .join("-")
    .toUpperCase();
};

export const encodeIdentityKey = (publicKey: Uint8Array): string => Base64Url.encode(publicKey);

export const decodeIdentityKey = (value: string): Uint8Array | undefined => {
  try {
    const bytes = Result.getOrThrow(Base64Url.decode(value));
    return bytes.length === KEY_LENGTH ? Uint8Array.from(bytes) : undefined;
  } catch {
    return undefined;
  }
};

const deriveRecordKeys = Effect.fn("socketE2ee.deriveRecordKeys")(function* (
  sharedSecret: Uint8Array,
  transcript: Uint8Array,
) {
  const c2sBytes = hkdf(
    sha256,
    sharedSecret,
    transcript,
    new TextEncoder().encode(C2S_INFO),
    KEY_LENGTH,
  );
  const s2cBytes = hkdf(
    sha256,
    sharedSecret,
    transcript,
    new TextEncoder().encode(S2C_INFO),
    KEY_LENGTH,
  );
  const c2s = yield* Aead.key(Aead.xchacha20Poly1305, c2sBytes);
  const s2c = yield* Aead.key(Aead.xchacha20Poly1305, s2cBytes);
  return { c2s, s2c } as const;
});

const transcriptHash = (parts: {
  readonly environmentId: string;
  readonly clientEphemeralPub: Uint8Array;
  readonly clientNonce: Uint8Array;
  readonly serverEphemeralPub: Uint8Array;
  readonly serverNonce: Uint8Array;
  readonly serverIdentityPub: Uint8Array;
}): Uint8Array =>
  sha256(
    concatBytes(
      new TextEncoder().encode(TRANSCRIPT_PREFIX),
      lengthPrefixed(parts.environmentId),
      parts.clientEphemeralPub,
      parts.clientNonce,
      parts.serverEphemeralPub,
      parts.serverNonce,
      parts.serverIdentityPub,
    ),
  );

const encodeClientHello = (ephemeralPub: Uint8Array, nonce: Uint8Array): Uint8Array =>
  concatBytes(new Uint8Array([CLIENT_HELLO_TYPE, PROTOCOL_VERSION]), ephemeralPub, nonce);

const decodeClientHello = (
  frame: Uint8Array,
): { readonly ephemeralPub: Uint8Array; readonly nonce: Uint8Array } | undefined => {
  if (
    frame.length !== 2 + KEY_LENGTH + NONCE_LENGTH ||
    frame[0] !== CLIENT_HELLO_TYPE ||
    frame[1] !== PROTOCOL_VERSION
  ) {
    return undefined;
  }
  return {
    ephemeralPub: frame.slice(2, 2 + KEY_LENGTH),
    nonce: frame.slice(2 + KEY_LENGTH),
  };
};

const encodeServerHello = (hello: {
  readonly ephemeralPub: Uint8Array;
  readonly nonce: Uint8Array;
  readonly identityPub: Uint8Array;
  readonly signature: Uint8Array;
  readonly environmentId: string;
}): Uint8Array =>
  concatBytes(
    new Uint8Array([SERVER_HELLO_TYPE, PROTOCOL_VERSION]),
    hello.ephemeralPub,
    hello.nonce,
    hello.identityPub,
    hello.signature,
    lengthPrefixed(hello.environmentId),
  );

const decodeServerHello = (
  frame: Uint8Array,
):
  | {
      readonly ephemeralPub: Uint8Array;
      readonly nonce: Uint8Array;
      readonly identityPub: Uint8Array;
      readonly signature: Uint8Array;
      readonly environmentId: string;
    }
  | undefined => {
  const fixedLength = 2 + KEY_LENGTH * 3 + SIGNATURE_LENGTH;
  if (
    frame.length < fixedLength + 2 ||
    frame[0] !== SERVER_HELLO_TYPE ||
    frame[1] !== PROTOCOL_VERSION
  ) {
    return undefined;
  }
  const environmentIdLength = ((frame[fixedLength] ?? 0) << 8) | (frame[fixedLength + 1] ?? 0);
  if (frame.length !== fixedLength + 2 + environmentIdLength) {
    return undefined;
  }
  let offset = 2;
  const ephemeralPub = frame.slice(offset, (offset += KEY_LENGTH));
  const nonce = frame.slice(offset, (offset += NONCE_LENGTH));
  const identityPub = frame.slice(offset, (offset += KEY_LENGTH));
  const signature = frame.slice(offset, (offset += SIGNATURE_LENGTH));
  const environmentId = new TextDecoder().decode(frame.slice(offset + 2));
  return { ephemeralPub, nonce, identityPub, signature, environmentId };
};

interface E2eeSession {
  readonly sendKey: Aead.Key;
  readonly recvKey: Aead.Key;
  sendCounter: number;
  recvCounter: number;
}

const nextNonce = (counter: number): Uint8Array => {
  const nonce = new Uint8Array(NONCE_PREFIX_LENGTH + RECORD_COUNTER_LENGTH);
  nonce.set(bigEndianCounter(counter), NONCE_PREFIX_LENGTH);
  return nonce;
};

const aad = (direction: number, counter: number): Uint8Array =>
  concatBytes(new Uint8Array([RECORD_VERSION, direction]), bigEndianCounter(counter));

const encryptRecord = Effect.fnUntraced(function* (
  session: E2eeSession,
  aead: AeadService,
  plaintext: Uint8Array,
  direction: number,
) {
  if (session.sendCounter >= MAX_RECORD_COUNTER) {
    return yield* new E2eeProtocolError({
      detail: "The E2EE session reached its record limit. Reconnect for fresh keys.",
    });
  }
  const counter = session.sendCounter;
  session.sendCounter += 1;
  return yield* aead.encrypt(session.sendKey, plaintext, {
    nonce: nextNonce(counter),
    aad: aad(direction, counter),
  });
});

const decryptRecord = Effect.fnUntraced(function* (
  session: E2eeSession,
  aead: AeadService,
  frame: Uint8Array,
  direction: number,
) {
  if (frame.length < RECORD_HEADER_LENGTH + TAG_LENGTH) {
    return yield* new E2eeProtocolError({ detail: "E2EE record is too short." });
  }
  if (frame[0] !== RECORD_VERSION) {
    return yield* new E2eeProtocolError({ detail: "Unknown E2EE record version." });
  }
  const counter = readBigEndianCounter(frame, 1);
  if (counter !== session.recvCounter) {
    return yield* new E2eeProtocolError({
      detail:
        counter < session.recvCounter
          ? "E2EE record replayed."
          : "E2EE record arrived out of order.",
    });
  }
  const plaintext = yield* aead.decrypt(session.recvKey, frame.slice(RECORD_HEADER_LENGTH), {
    nonce: nextNonce(counter),
    aad: aad(direction, counter),
  });
  session.recvCounter += 1;
  return plaintext;
});

const encodeRecord = (ciphertext: Uint8Array, counter: number): Uint8Array =>
  concatBytes(new Uint8Array([RECORD_VERSION]), bigEndianCounter(counter), ciphertext);

interface ActiveConnection {
  readonly session: E2eeSession;
}

interface E2eeSocketConfig {
  readonly role: "client" | "server";
  readonly aead: AeadService;
  readonly environmentId: string;
  readonly identitySeed?: Uint8Array | undefined;
  readonly expectedServerIdentityKey?: Uint8Array | undefined;
}

const handshakeError = (error: E2eeHandshakeError): Socket.SocketError =>
  new Socket.SocketError({ reason: new Socket.SocketReadError({ cause: error }) });

const recordError = (error: E2eeProtocolError): Socket.SocketError =>
  new Socket.SocketError({ reason: new Socket.SocketReadError({ cause: error }) });

const pullHandshakeFrame = (pull: Socket.Reader["pull"]) =>
  Effect.flatMap(pull, (batch) =>
    batch.length === 1 && typeof batch[0] !== "string"
      ? Effect.succeed(batch[0] as Uint8Array)
      : Effect.fail(
          new E2eeProtocolError({ detail: "Unexpected frame during the E2EE handshake." }),
        ),
  );

const makeE2eeSocket = Effect.fn("socketE2ee.makeSocket")(function* (
  socket: Socket.Socket,
  config: E2eeSocketConfig,
) {
  // The deferred for the connection a writer may send on. Each reader
  // acquisition installs its own deferred before the handshake and resolves it
  // on completion, so a writer either sends on the live session or waits for
  // the next handshake.
  const tickets = yield* Ref.make<Deferred.Deferred<ActiveConnection, Socket.SocketError>>(
    yield* Deferred.make<ActiveConnection, Socket.SocketError>(),
  );
  const random = yield* SecureRandom.SecureRandom;
  const writeLock = Semaphore.makeUnsafe(1);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // The writer is acquired independently of the reader, so it sends only once
  // the current connection's handshake is done. A write that races a reconnect
  // may carry the old session's keys onto the new connection, which the peer
  // rejects, closing the socket and triggering a fresh reconnect.
  const writerLoop = (
    writer: Socket.Writer,
    chunk: Uint8Array | string | Socket.CloseEvent,
  ): Effect.Effect<void, Socket.SocketError> => {
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
      return writer.write(chunk);
    }
    const plaintext = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    // Counter assignment, encryption and the write must be one atomic step:
    // concurrent writers would otherwise reorder records or stamp the wrong counter.
    const send = Effect.flatMap(Ref.get(tickets), (ticket) =>
      Effect.flatMap(Deferred.await(ticket), (connection) =>
        writeLock.withPermit(
          Effect.gen(function* () {
            const direction = config.role === "client" ? DIRECTION_C2S : DIRECTION_S2C;
            const counter = connection.session.sendCounter;
            const ciphertext = yield* encryptRecord(
              connection.session,
              config.aead,
              plaintext,
              direction,
            );
            yield* writer.write(encodeRecord(ciphertext, counter));
          }),
        ),
      ),
    );
    return Effect.catchIf(
      send,
      () => true,
      (error) =>
        Effect.fail(
          new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause: error }) }),
        ),
    );
  };

  /** When this connection's scope closes, make later writers wait for the next handshake. */
  const retireTicket = (ticket: Deferred.Deferred<ActiveConnection, Socket.SocketError>) =>
    Ref.modify(tickets, (current) => {
      const next =
        current === ticket ? Deferred.makeUnsafe<ActiveConnection, Socket.SocketError>() : current;
      return [undefined, next] as const;
    }).pipe(Effect.asVoid);

  const clientHandshake = Effect.fn("socketE2ee.clientHandshake")(function* (
    reader: Socket.Reader,
    writer: Socket.Writer,
  ) {
    const ephemeralPriv = Uint8Array.from(yield* random.randomBytes(KEY_LENGTH));
    const ephemeralPub = x25519.getPublicKey(ephemeralPriv);
    const clientNonce = Uint8Array.from(yield* random.randomBytes(KEY_LENGTH));
    yield* writer.write(encodeClientHello(ephemeralPub, clientNonce));
    const helloFrame = yield* pullHandshakeFrame(reader.pull);
    const hello = decodeServerHello(helloFrame);
    if (hello === undefined) {
      return yield* new E2eeProtocolError({
        detail: "The server sent an invalid E2EE handshake.",
      });
    }
    const transcript = transcriptHash({
      environmentId: config.environmentId,
      clientEphemeralPub: ephemeralPub,
      clientNonce,
      serverEphemeralPub: hello.ephemeralPub,
      serverNonce: hello.nonce,
      serverIdentityPub: hello.identityPub,
    });
    const signatureValid = ed25519.verify(hello.signature, transcript, hello.identityPub);
    const identityMatches =
      config.expectedServerIdentityKey !== undefined &&
      timingSafeEqual(hello.identityPub, config.expectedServerIdentityKey);
    if (!signatureValid || !identityMatches) {
      return yield* !signatureValid
        ? new E2eeProtocolError({
            detail: "The server's E2EE handshake signature is invalid.",
          })
        : new E2eeIdentityMismatchError({
            pinnedFingerprint: identityFingerprint(config.expectedServerIdentityKey!),
            receivedFingerprint: identityFingerprint(hello.identityPub),
          });
    }
    const sharedSecret = x25519.getSharedSecret(ephemeralPriv, hello.ephemeralPub);
    const keys = yield* deriveRecordKeys(sharedSecret, transcript);
    const session: E2eeSession = {
      sendKey: keys.c2s,
      recvKey: keys.s2c,
      sendCounter: 0,
      recvCounter: 0,
    };
    // Key confirmation: an empty record under the c2s key before any RPC.
    const confirm = yield* encryptRecord(session, config.aead, new Uint8Array(0), DIRECTION_C2S);
    yield* writer.write(encodeRecord(confirm, 0));
    return session;
  });

  const serverHandshake = Effect.fn("socketE2ee.serverHandshake")(function* (
    reader: Socket.Reader,
    writer: Socket.Writer,
  ) {
    const seed = config.identitySeed;
    if (seed === undefined) {
      return yield* new E2eeProtocolError({ detail: "The server has no E2EE identity key." });
    }
    const identityPub = identityPublicKeyFromSeed(seed);
    const helloFrame = yield* pullHandshakeFrame(reader.pull);
    const hello = decodeClientHello(helloFrame);
    if (hello === undefined) {
      return yield* new E2eeProtocolError({
        detail: "The client sent an invalid E2EE handshake.",
      });
    }
    const ephemeralPriv = Uint8Array.from(yield* random.randomBytes(KEY_LENGTH));
    const ephemeralPub = x25519.getPublicKey(ephemeralPriv);
    const serverNonce = Uint8Array.from(yield* random.randomBytes(KEY_LENGTH));
    const transcript = transcriptHash({
      environmentId: config.environmentId,
      clientEphemeralPub: hello.ephemeralPub,
      clientNonce: hello.nonce,
      serverEphemeralPub: ephemeralPub,
      serverNonce,
      serverIdentityPub: identityPub,
    });
    const signature = ed25519.sign(transcript, seed);
    yield* writer.write(
      encodeServerHello({
        ephemeralPub,
        nonce: serverNonce,
        identityPub,
        signature,
        environmentId: config.environmentId,
      }),
    );
    const sharedSecret = x25519.getSharedSecret(ephemeralPriv, hello.ephemeralPub);
    const keys = yield* deriveRecordKeys(sharedSecret, transcript);
    const session: E2eeSession = {
      sendKey: keys.s2c,
      recvKey: keys.c2s,
      sendCounter: 0,
      recvCounter: 0,
    };
    // The client's empty confirm record proves it derived the same keys.
    const confirmFrame = yield* pullHandshakeFrame(reader.pull);
    const confirm = yield* decryptRecord(session, config.aead, confirmFrame, DIRECTION_C2S);
    if (confirm.length !== 0) {
      return yield* new E2eeProtocolError({
        detail: "The E2EE key confirmation record was not empty.",
      });
    }
    return session;
  });

  const isHandshakeError = (error: unknown): error is E2eeHandshakeError =>
    isProtocolError(error) || isIdentityMismatchError(error);

  return Socket.make({
    reader: Effect.gen(function* () {
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const ticket = yield* Deferred.make<ActiveConnection, Socket.SocketError>();
      yield* Ref.set(tickets, ticket);
      const outcome = yield* Effect.result(
        (config.role === "client"
          ? clientHandshake(reader, writer)
          : serverHandshake(reader, writer)
        ).pipe(
          Effect.timeout(E2EE_HANDSHAKE_TIMEOUT),
          Effect.catchIf(
            Cause.isTimeoutError,
            () => new E2eeProtocolError({ detail: "The E2EE handshake timed out." }),
          ),
        ),
      );
      if (Result.isFailure(outcome)) {
        const failure = outcome.failure;
        const socketError = isHandshakeError(failure)
          ? handshakeError(failure)
          : new Socket.SocketError({
              reason: new Socket.SocketReadError({ cause: failure }),
            });
        yield* retireTicket(ticket);
        yield* Deferred.fail(ticket, socketError);
        return yield* socketError;
      }
      const session = outcome.success;
      yield* Deferred.succeed(ticket, { session });
      yield* Effect.addFinalizer(() => retireTicket(ticket));
      const direction = config.role === "client" ? DIRECTION_S2C : DIRECTION_C2S;
      const decryptChunk = (chunk: Uint8Array | string) =>
        typeof chunk === "string"
          ? Effect.fail(
              recordError(
                new E2eeProtocolError({ detail: "A plaintext frame arrived on an E2EE socket." }),
              ),
            )
          : Effect.mapBoth(decryptRecord(session, config.aead, chunk, direction), {
              onFailure: (error) =>
                recordError(
                  isProtocolError(error)
                    ? error
                    : new E2eeProtocolError({ detail: "E2EE record decryption failed." }),
                ),
              onSuccess: (plaintext) => decoder.decode(plaintext),
            });
      return {
        upgrade: reader.upgrade,
        pull: Effect.map(
          Effect.flatMap(reader.pull, (batch) => Effect.forEach(batch, decryptChunk)),
          (frames) => frames as NonEmptyReadonlyArray<string>,
        ),
      } satisfies Socket.Reader;
    }),
    writer: Effect.map(socket.writer, (writer) => ({
      write: (chunk) => writerLoop(writer, chunk),
      writeAll: (chunks) =>
        Effect.forEach(chunks, (chunk) => writerLoop(writer, chunk), { discard: true }),
    })),
  });
});

/**
 * Client side: verify the pinned server identity, then encrypt every frame.
 * The handshake re-runs per connection, so each reconnect derives fresh
 * ephemeral keys.
 */
export const wrapClientSocketWithE2ee = Effect.fn("socketE2ee.wrapClientSocket")(function* (
  socket: Socket.Socket,
  options: {
    readonly environmentId: string;
    readonly expectedServerIdentityKey: Uint8Array;
  },
) {
  return yield* makeE2eeSocket(socket, {
    role: "client",
    aead: yield* Aead.Aead,
    environmentId: options.environmentId,
    expectedServerIdentityKey: options.expectedServerIdentityKey,
  });
});

/** Server side: sign the handshake with the environment's identity key. */
export const wrapServerSocketWithE2ee = Effect.fn("socketE2ee.wrapServerSocket")(function* (
  socket: Socket.Socket,
  options: {
    readonly environmentId: string;
    readonly identitySeed: Uint8Array;
  },
) {
  return yield* makeE2eeSocket(socket, {
    role: "server",
    aead: yield* Aead.Aead,
    environmentId: options.environmentId,
    identitySeed: options.identitySeed,
  });
});

/** Layers the wrappers need. XChaCha20-Poly1305 never touches `crypto.subtle`. */
export const layerE2eeCrypto = Aead.layerWebCrypto.pipe(
  Layer.provideMerge(SecureRandom.layerWebCrypto),
);

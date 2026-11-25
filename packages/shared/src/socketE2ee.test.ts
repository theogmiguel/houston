import * as Aead from "effect/crypto/Aead";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Socket from "effect/socket/Socket";

import {
  E2eeIdentityMismatchError,
  E2eeProtocolError,
  decodeIdentityKey,
  encodeIdentityKey,
  generateIdentityKeypair,
  identityFingerprint,
  identityPublicKeyFromSeed,
  wrapClientSocketWithE2ee,
  wrapServerSocketWithE2ee,
} from "./socketE2ee.ts";

const ENVIRONMENT_ID = "env-e2ee-test";

type Frame = Uint8Array | string;

/** An in-memory socket pair: each side's writer feeds the peer's reader. */
const makeSocketPair = Effect.gen(function* () {
  const clientToServer = yield* Queue.unbounded<Frame>();
  const serverToClient = yield* Queue.unbounded<Frame>();
  const end = (inbound: Queue.Queue<Frame>, outbound: Queue.Queue<Frame>): Socket.Socket =>
    Socket.make({
      reader: Effect.succeed({
        upgrade: (): Effect.Effect<void, Socket.SocketError> =>
          Effect.fail(
            new Socket.SocketError({
              reason: new Socket.SocketUpgradeError({ cause: "unsupported" }),
            }),
          ),
        pull: Effect.map(Queue.take(inbound), (frame) => [frame] as const),
      }),
      writer: Effect.succeed({
        write: (chunk) => Effect.asVoid(Queue.offer(outbound, chunk as Frame)),
        writeAll: (chunks) =>
          Effect.forEach(chunks, (chunk) => Queue.offer(outbound, chunk as Frame), {
            discard: true,
          }),
      }),
    });
  return {
    client: end(serverToClient, clientToServer),
    server: end(clientToServer, serverToClient),
    clientToServer,
    serverToClient,
  };
});

/** Forwards to `target` while recording every binary frame written. */
const recordingSocket = (target: Socket.Socket, captured: Array<Uint8Array>): Socket.Socket =>
  Socket.make({
    reader: Effect.map(target.reader, (reader) => ({
      upgrade: reader.upgrade,
      pull: reader.pull,
    })),
    writer: Effect.map(target.writer, (writer) => ({
      write: (chunk) => {
        if (chunk instanceof Uint8Array) captured.push(chunk);
        return writer.write(chunk);
      },
      writeAll: (chunks) => {
        for (const chunk of chunks) {
          if (chunk instanceof Uint8Array) captured.push(chunk);
        }
        return writer.writeAll(chunks);
      },
    })),
  });

/** Forwards to `target` while offering every binary frame written to a queue. */
const queueRecordingSocket = (
  target: Socket.Socket,
  captured: Queue.Queue<Uint8Array>,
): Socket.Socket =>
  Socket.make({
    reader: Effect.map(target.reader, (reader) => ({
      upgrade: reader.upgrade,
      pull: reader.pull,
    })),
    writer: Effect.map(target.writer, (writer) => ({
      write: (chunk) =>
        chunk instanceof Uint8Array
          ? Effect.andThen(Queue.offer(captured, chunk), writer.write(chunk))
          : writer.write(chunk),
      writeAll: (chunks) =>
        Effect.forEach(
          chunks,
          (chunk) =>
            chunk instanceof Uint8Array
              ? Effect.andThen(Queue.offer(captured, chunk), writer.write(chunk))
              : writer.write(chunk),
          { discard: true },
        ),
    })),
  });

/** Pulls the E2EE failure out of a failed reader acquisition or pull. */
const e2eeCause = (error: unknown): unknown => {
  const tag = (error as { readonly _tag?: string } | undefined)?._tag;
  if (tag === "SocketReadError" || tag === "SocketWriteError") {
    return (error as { readonly cause?: unknown }).cause;
  }
  const reason = (error as { readonly reason?: { readonly _tag?: string } | undefined })?.reason;
  if (
    reason !== undefined &&
    (reason._tag === "SocketReadError" || reason._tag === "SocketWriteError")
  ) {
    return (reason as { readonly cause?: unknown }).cause;
  }
  return undefined;
};
/** The failed error of an exited client round, if any. */
const e2eeExitFailure = (exit: Exit.Exit<unknown, unknown>): unknown => {
  const failure = Exit.match(exit, {
    onFailure: (cause) => Option.getOrUndefined(Cause.findErrorOption(cause)),
    onSuccess: () => undefined,
  });
  return failure;
};
const isE2eeIdentityMismatch = (error: unknown): error is E2eeIdentityMismatchError =>
  (error as { readonly _tag?: string } | undefined)?._tag === "E2eeIdentityMismatchError";
const isE2eeProtocolError = (error: unknown): error is E2eeProtocolError =>
  (error as { readonly _tag?: string } | undefined)?._tag === "E2eeProtocolError";

/** The server side of a session that only completes the handshake. */
const serverHandshakeOnly = (socket: Socket.Socket, seed: Uint8Array) =>
  Effect.gen(function* () {
    const wrapped = yield* wrapServerSocketWithE2ee(socket, {
      environmentId: ENVIRONMENT_ID,
      identitySeed: seed,
    });
    yield* wrapped.reader;
  });

describe("socketE2ee", () => {
  it.effect("identity keys round-trip through base64url and fingerprint", () =>
    Effect.gen(function* () {
      const keypair = yield* generateIdentityKeypair();
      assert.equal(keypair.seed.length, 32);
      assert.equal(keypair.publicKey.length, 32);
      assert.deepEqual(identityPublicKeyFromSeed(keypair.seed), keypair.publicKey);
      const encoded = encodeIdentityKey(keypair.publicKey);
      const decoded = decodeIdentityKey(encoded);
      assert.isDefined(decoded);
      assert.deepEqual(Array.from(decoded!), Array.from(keypair.publicKey));
      assert.match(identityFingerprint(keypair.publicKey), /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
      assert.isUndefined(decodeIdentityKey("not-base64url!!"));
      assert.isUndefined(decodeIdentityKey(encodeIdentityKey(new Uint8Array(31))));
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.live("handshake and bidirectional records round-trip", () =>
    Effect.gen(function* () {
      const pair = yield* makeSocketPair;
      const identity = yield* generateIdentityKeypair();
      const serverDone = yield* Deferred.make<void>();
      const serverFiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          const wrapped = yield* wrapServerSocketWithE2ee(pair.server, {
            environmentId: ENVIRONMENT_ID,
            identitySeed: identity.seed,
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const reader = yield* wrapped.reader;
              const writer = yield* wrapped.writer;
              yield* writer.write('{"from":"server"}');
              // The pair delivers one frame per pull.
              const first = yield* reader.pull;
              assert.deepEqual([...first], ['{"from":"client"}']);
              const second = yield* reader.pull;
              assert.deepEqual([...second], ['{"from":"client-2"}']);
              yield* Deferred.succeed(serverDone, undefined);
            }),
          );
        }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const wrapped = yield* wrapClientSocketWithE2ee(pair.client, {
            environmentId: ENVIRONMENT_ID,
            expectedServerIdentityKey: identity.publicKey,
          });
          const reader = yield* wrapped.reader;
          const writer = yield* wrapped.writer;
          yield* writer.write('{"from":"client"}');
          yield* writer.write('{"from":"client-2"}');
          const batch = yield* reader.pull;
          assert.deepEqual([...batch], ['{"from":"server"}']);
        }),
      );
      yield* Deferred.await(serverDone);
      yield* Fiber.interrupt(serverFiber);
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.live("concurrent writers keep records ordered and counters correct", () =>
    Effect.gen(function* () {
      const pair = yield* makeSocketPair;
      const identity = yield* generateIdentityKeypair();
      const count = 200;
      const received = yield* Deferred.make<ReadonlyArray<string>>();
      const serverFiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          const wrapped = yield* wrapServerSocketWithE2ee(pair.server, {
            environmentId: ENVIRONMENT_ID,
            identitySeed: identity.seed,
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const reader = yield* wrapped.reader;
              const frames: Array<string> = [];
              while (frames.length < count) {
                frames.push(...(yield* reader.pull).map(String));
              }
              yield* Deferred.succeed(received, frames);
            }),
          );
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const wrapped = yield* wrapClientSocketWithE2ee(pair.client, {
            environmentId: ENVIRONMENT_ID,
            expectedServerIdentityKey: identity.publicKey,
          });
          yield* wrapped.reader;
          const writer = yield* wrapped.writer;
          yield* Effect.forEach(
            Array.from({ length: count }, (_, index) => `frame-${index}`),
            (frame) => writer.write(frame),
            { concurrency: "unbounded", discard: true },
          );
          const frames = yield* Deferred.await(received);
          assert.equal(frames.length, count);
          assert.deepEqual(
            [...frames].sort(),
            Array.from({ length: count }, (_, i) => `frame-${i}`).sort(),
          );
        }),
      );
      yield* Fiber.interrupt(serverFiber);
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect("every wire frame after the handshake is opaque binary ciphertext", () =>
    Effect.gen(function* () {
      const pair = yield* makeSocketPair;
      const identity = yield* generateIdentityKeypair();
      const secret = "super secret prompt with /home/user/paths";
      const serverFiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          const wrapped = yield* wrapServerSocketWithE2ee(pair.server, {
            environmentId: ENVIRONMENT_ID,
            identitySeed: identity.seed,
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const reader = yield* wrapped.reader;
              const writer = yield* wrapped.writer;
              yield* writer.write(secret);
              yield* reader.pull;
            }),
          );
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const wrapped = yield* wrapClientSocketWithE2ee(pair.client, {
            environmentId: ENVIRONMENT_ID,
            expectedServerIdentityKey: identity.publicKey,
          });
          const reader = yield* wrapped.reader;
          const writer = yield* wrapped.writer;
          yield* writer.write("ping");
          const batch = yield* reader.pull;
          assert.deepEqual([...batch], [secret]);
        }),
      );
      yield* Fiber.interrupt(serverFiber);
      for (const frame of yield* Queue.clear(pair.serverToClient)) {
        assert.instanceOf(frame, Uint8Array);
        assert.notEqual((frame as Uint8Array)[0], 0x7b); // never "{"
      }
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect("a wrong pinned identity key aborts the handshake", () =>
    Effect.gen(function* () {
      const pair = yield* makeSocketPair;
      const identity = yield* generateIdentityKeypair();
      const rogue = yield* generateIdentityKeypair();
      const serverFiber = yield* Effect.forkScoped(
        serverHandshakeOnly(pair.server, identity.seed).pipe(Effect.ignore),
      );
      const failure = yield* Effect.flip(
        Effect.scoped(
          Effect.gen(function* () {
            const wrapped = yield* wrapClientSocketWithE2ee(pair.client, {
              environmentId: ENVIRONMENT_ID,
              expectedServerIdentityKey: rogue.publicKey,
            });
            yield* wrapped.reader;
          }),
        ),
      );
      const cause = e2eeCause(failure);
      assert.isTrue(
        isE2eeIdentityMismatch(cause),
        `expected identity mismatch, got ${String(cause)}`,
      );
      if (isE2eeIdentityMismatch(cause)) {
        assert.equal(cause.pinnedFingerprint, identityFingerprint(rogue.publicKey));
        assert.equal(cause.receivedFingerprint, identityFingerprint(identity.publicKey));
      }
      yield* Fiber.interrupt(serverFiber);
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect("a cross-environment transcript fails signature verification", () =>
    Effect.gen(function* () {
      const pair = yield* makeSocketPair;
      const identity = yield* generateIdentityKeypair();
      const serverFiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          const wrapped = yield* wrapServerSocketWithE2ee(pair.server, {
            environmentId: "env-other",
            identitySeed: identity.seed,
          });
          yield* wrapped.reader;
        }).pipe(Effect.ignore),
      );
      const failure = yield* Effect.flip(
        Effect.scoped(
          Effect.gen(function* () {
            const wrapped = yield* wrapClientSocketWithE2ee(pair.client, {
              environmentId: ENVIRONMENT_ID,
              expectedServerIdentityKey: identity.publicKey,
            });
            yield* wrapped.reader;
          }),
        ),
      );
      const cause = e2eeCause(failure);
      // The pinned key matches, but the transcript names another environment.
      assert.isTrue(isE2eeProtocolError(cause), `expected protocol error, got ${String(cause)}`);
      yield* Fiber.interrupt(serverFiber);
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect("tampered, replayed, and reordered records close the socket", () =>
    Effect.gen(function* () {
      const pair = yield* makeSocketPair;
      const identity = yield* generateIdentityKeypair();
      const capturedServerFrames = yield* Queue.unbounded<Uint8Array>();

      // The server serves one connection per round: handshake, then two records.
      const serverFiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          const wrapped = yield* wrapServerSocketWithE2ee(
            queueRecordingSocket(pair.server, capturedServerFrames),
            {
              environmentId: ENVIRONMENT_ID,
              identitySeed: identity.seed,
            },
          );
          for (let round = 0; round < 4; round += 1) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* wrapped.reader;
                const writer = yield* wrapped.writer;
                yield* writer.write("record-zero");
                yield* writer.write("record-one");
              }),
            );
          }
        }),
      );

      // Client side of one round: connect, wait for the gate, then pull as directed.
      const clientRound = (gate: Deferred.Deferred<void>) =>
        Effect.gen(function* () {
          const wrapped = yield* wrapClientSocketWithE2ee(pair.client, {
            environmentId: ENVIRONMENT_ID,
            expectedServerIdentityKey: identity.publicKey,
          });
          const reader = yield* wrapped.reader;
          yield* Deferred.await(gate);
          const first = yield* reader.pull;
          const second = yield* reader.pull;
          return [first, second] as const;
        });

      const runRound = Effect.fn("test.round")(function* (
        roundLabel: string,
        manipulate: (records: ReadonlyArray<Uint8Array>) => ReadonlyArray<Uint8Array>,
      ) {
        const gate = yield* Deferred.make<void>();
        const client = yield* Effect.forkScoped(clientRound(gate));
        // A failed round leaves an unread record behind; drop it before the
        // next handshake reads it as its ServerHello.
        yield* Queue.clear(pair.serverToClient);
        // hello, record-zero, record-one — as written by this round's session.
        yield* Queue.take(capturedServerFrames);
        const zero = yield* Queue.take(capturedServerFrames);
        const one = yield* Queue.take(capturedServerFrames);
        // The client has not pulled yet; replace what it will read.
        yield* Queue.clear(pair.serverToClient);
        yield* Effect.forEach(
          manipulate([zero!, one!]),
          (frame) => Queue.offer(pair.serverToClient, frame),
          { discard: true },
        );
        yield* Deferred.succeed(gate, undefined);
        return yield* Fiber.await(client);
      });

      // Round 0 is the control: both records decrypt in order.
      const control = yield* runRound("control", (records) => records);
      if (!Exit.isSuccess(control)) {
        return assert.fail(`control round failed: ${String(e2eeExitFailure(control))}`);
      }
      assert.deepEqual([...control.value[0]!], ["record-zero"]);
      assert.deepEqual([...control.value[1]!], ["record-one"]);

      // Round 1: a flipped bit in the first record's ciphertext fails the pull.
      const tampered = yield* runRound("tampered", (records) => {
        const broken = new Uint8Array(records[0]!);
        const last = broken.length - 1;
        broken[last] = (broken[last] ?? 0) ^ 0xff;
        return [broken, records[1]!];
      });
      if (!Exit.isFailure(tampered)) {
        return assert.fail("tampered record was accepted");
      }
      const tamperedCause = e2eeExitFailure(tampered);
      assert.isDefined(e2eeCause(tamperedCause));

      // Round 2: delivering the first record twice replays it.
      const replayed = yield* runRound("replay", (records) => [records[0]!, records[0]!]);
      if (!Exit.isFailure(replayed)) {
        return assert.fail("replayed record was accepted");
      }
      const replayCause = e2eeCause(e2eeExitFailure(replayed));
      assert.isTrue(
        isE2eeProtocolError(replayCause) && replayCause.message.includes("replayed"),
        `expected replay rejection, got ${String(replayCause)}`,
      );

      // Round 3: the second record delivered first is out of order.
      const reordered = yield* runRound("reorder", (records) => [records[1]!, records[0]!]);
      if (!Exit.isFailure(reordered)) {
        return assert.fail("reordered record was accepted");
      }
      const reorderCause = e2eeCause(e2eeExitFailure(reordered));
      assert.isTrue(
        isE2eeProtocolError(reorderCause) && reorderCause.message.includes("out of order"),
        `expected reorder rejection, got ${String(reorderCause)}`,
      );

      yield* Fiber.interrupt(serverFiber);
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect("a plaintext frame on an E2EE socket closes the reader", () =>
    Effect.gen(function* () {
      const pair = yield* makeSocketPair;
      const identity = yield* generateIdentityKeypair();
      const serverFiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          const wrapped = yield* wrapServerSocketWithE2ee(pair.server, {
            environmentId: ENVIRONMENT_ID,
            identitySeed: identity.seed,
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const reader = yield* wrapped.reader;
              const writer = yield* wrapped.writer;
              yield* writer.write("ok");
              yield* reader.pull;
            }),
          );
        }),
      );
      const failure = yield* Effect.flip(
        Effect.scoped(
          Effect.gen(function* () {
            const wrapped = yield* wrapClientSocketWithE2ee(pair.client, {
              environmentId: ENVIRONMENT_ID,
              expectedServerIdentityKey: identity.publicKey,
            });
            const reader = yield* wrapped.reader;
            const writer = yield* wrapped.writer;
            yield* writer.write("ping");
            const batch = yield* reader.pull;
            assert.deepEqual([...batch], ["ok"]);
            yield* Queue.offer(pair.serverToClient, '{"plaintext":true}');
            yield* reader.pull;
          }),
        ),
      );
      const cause = e2eeCause(failure);
      assert.isTrue(
        isE2eeProtocolError(cause) && cause.message.includes("plaintext"),
        `expected plaintext rejection, got ${String(cause)}`,
      );
      yield* Fiber.interrupt(serverFiber);
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect("reconnects derive fresh ephemeral keys", () =>
    Effect.gen(function* () {
      const pair = yield* makeSocketPair;
      const identity = yield* generateIdentityKeypair();
      const hellos: Array<Uint8Array> = [];

      const serverAck = Effect.gen(function* () {
        const wrapped = yield* wrapServerSocketWithE2ee(pair.server, {
          environmentId: ENVIRONMENT_ID,
          identitySeed: identity.seed,
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* wrapped.reader;
            const writer = yield* wrapped.writer;
            const batch = yield* reader.pull;
            assert.deepEqual([...batch], ["round"]);
            yield* writer.write('{"from":"server"}');
          }),
        );
      });

      for (let round = 0; round < 2; round += 1) {
        const captured: Array<Uint8Array> = [];
        const roundRecording = recordingSocket(pair.client, captured);
        const serverFiber = yield* Effect.forkScoped(serverAck);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const wrapped = yield* wrapClientSocketWithE2ee(roundRecording, {
              environmentId: ENVIRONMENT_ID,
              expectedServerIdentityKey: identity.publicKey,
            });
            const reader = yield* wrapped.reader;
            const writer = yield* wrapped.writer;
            yield* writer.write("round");
            const batch = yield* reader.pull;
            assert.deepEqual([...batch], ['{"from":"server"}']);
          }),
        );
        yield* Fiber.interrupt(serverFiber);
        // The first write of each connection is its ClientHello.
        assert.equal(captured.length, 3);
        hellos.push(captured[0]!);
      }
      // Two connections: each wrote its own ClientHello with fresh ephemerals.
      assert.equal(hellos.length, 2);
      assert.notDeepEqual(Array.from(hellos[0]!), Array.from(hellos[1]!));
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );
});

const layerE2eeCrypto = Aead.layerWebCrypto.pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));

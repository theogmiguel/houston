// @effect-diagnostics nodeBuiltinImport:off - streams files through gzip and the age envelope.
// age passphrase envelope around gzip of `HOUSTON-TRANSFER 2\n` and frames (u32 BE name length,
// name, u64 BE size, bytes), `manifest.json` first. The reader treats every byte as hostile.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import {
  HOUSTON_TRANSFER_FORMAT,
  HOUSTON_TRANSFER_LIMITS,
  HoustonTransferError,
  decodeHoustonTransferManifest,
  type HoustonTransferManifest,
} from "@t3tools/contracts/houston/transfer";
import { Decrypter, Encrypter } from "age-encryption";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { entryNameProblem, formatSize, pathProblem, refusal } from "./rules.ts";

export const MAGIC = Buffer.from(`HOUSTON-TRANSFER ${HOUSTON_TRANSFER_FORMAT}\n`, "latin1");
const MANIFEST = "manifest.json";
/** A frame name longer than this is damage, not a path. */
const MAX_NAME_BYTES = 4_096;
/** The age header is read whole before any key is derived; a real one is a few hundred bytes. */
const MAX_HEADER_BYTES = 64 * 1024;

export interface FormatLimits {
  readonly fileBytes: number;
  readonly unpackedBytes: number;
  readonly manifestBytes: number;
  readonly entries: number;
}

const limitsOf = (partial: Partial<FormatLimits> = {}): FormatLimits => ({
  fileBytes: HOUSTON_TRANSFER_LIMITS.fileBytes,
  unpackedBytes: HOUSTON_TRANSFER_LIMITS.unpackedBytes,
  manifestBytes: HOUSTON_TRANSFER_LIMITS.manifestBytes,
  entries: HOUSTON_TRANSFER_LIMITS.entries,
  ...partial,
});

const EXPORT = "houston.transfer.export";

export const isTransferError = Schema.is(HoustonTransferError);

/** A format promise as an Effect: its refusals fail it, anything else is a defect. */
export const fromPromise = <A>(run: () => Promise<A>): Effect.Effect<A, HoustonTransferError> =>
  Effect.flatMap(
    Effect.promise(() =>
      run().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => {
          if (isTransferError(error)) return { ok: false as const, error };
          throw error;
        },
      ),
    ),
    (result) => (result.ok ? Effect.succeed(result.value) : Effect.fail(result.error)),
  );

const DAMAGED = "The file is damaged or was not made by Houston.";
const DAMAGED_STEPS = ["Export the workspace again on the computer that made the file."];

const damaged = (
  operation: string,
  items: ReadonlyArray<string>,
  bound?: {
    readonly limit: number;
    readonly actual: number;
  },
) => refusal("not_transfer_file", operation, DAMAGED, { items, steps: DAMAGED_STEPS, ...bound });

const notTransferFile = (operation: string, problem: string) =>
  refusal("not_transfer_file", operation, problem, {
    steps: ["Choose a file that Houston exported with Export transfer."],
  });

// Writing.

export interface PackEntry {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly open: () => AsyncIterable<Uint8Array>;
}

const sha256Of = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export const bytesEntry = (name: string, bytes: Uint8Array): PackEntry => ({
  name,
  size: bytes.length,
  sha256: sha256Of(bytes),
  open: async function* () {
    yield bytes;
  },
});

/** A file entry, hashed now and read again when packed; `onRead` sees each opening. */
export const fileEntry = async (
  name: string,
  path: string,
  onRead: (path: string) => void = () => undefined,
): Promise<PackEntry> => {
  onRead(path);
  const hash = NodeCrypto.createHash("sha256");
  let size = 0;
  for await (const chunk of NodeFS.createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  const sha256 = hash.digest("hex");
  return {
    name,
    size,
    sha256,
    open: async function* () {
      onRead(path);
      let read = 0;
      for await (const chunk of NodeFS.createReadStream(path)) {
        read += (chunk as Buffer).length;
        yield chunk as Buffer;
      }
      if (read !== size) throw new Error(`${path} changed while it was exported`);
    },
  };
};

const frameHeader = (name: string, size: number) => {
  const nameBytes = Buffer.from(name, "utf8");
  const header = Buffer.alloc(4 + nameBytes.length + 8);
  header.writeUInt32BE(nameBytes.length, 0);
  nameBytes.copy(header, 4);
  header.writeBigUInt64BE(BigInt(size), 4 + nameBytes.length);
  return header;
};

export const encodeFrame = (name: string, bytes: Uint8Array): Uint8Array =>
  Buffer.concat([frameHeader(name, bytes.length), bytes]);

/** Encrypts `plaintext` to `passphrase` as a standard age file. */
export const sealPlaintext = (plaintext: Uint8Array, passphrase: string, workFactor: number) => {
  const encrypter = new Encrypter();
  encrypter.setPassphrase(passphrase);
  encrypter.setScryptWorkFactor(workFactor);
  return encrypter.encrypt(plaintext);
};

const displayEntry = (name: string) => name.replace(/^checkouts\/[0-9]+\/untracked\//, "");

const tooLarge = (limit: number, entries: ReadonlyArray<PackEntry>) =>
  refusal(
    "too_large",
    EXPORT,
    `The transfer file would be larger than ${formatSize(limit)}, the most one file may hold.`,
    {
      items: [...entries]
        .toSorted((left, right) => right.size - left.size)
        .slice(0, 10)
        .map(
          (entry) => `${displayEntry(entry.name)} (${entry.size.toLocaleString("en-US")} bytes)`,
        ),
      steps: [
        "Push the commits that are not on a remote, or add large untracked files to .gitignore, then export again.",
      ],
      limit,
    },
  );

/** Writes `<file>.partial-<uuid>` and renames it into place, so a failure leaves neither file. */
export const writeTransferFile = async (input: {
  readonly file: string;
  readonly passphrase: string;
  readonly manifest: Omit<HoustonTransferManifest, "entries">;
  readonly entries: ReadonlyArray<PackEntry>;
  readonly workFactor?: number;
  readonly limits?: Partial<FormatLimits>;
}): Promise<{ readonly bytes: number }> => {
  const limits = limitsOf(input.limits);
  const manifest: HoustonTransferManifest = {
    ...input.manifest,
    entries: input.entries.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  async function* plaintext() {
    yield MAGIC;
    yield encodeFrame(MANIFEST, manifestBytes);
    for (const entry of input.entries) {
      yield frameHeader(entry.name, entry.size);
      yield* entry.open();
    }
  }
  const gzip = NodeZlib.createGzip();
  NodeStream.pipeline(NodeStream.Readable.from(plaintext()), gzip, () => undefined);
  const encrypter = new Encrypter();
  encrypter.setPassphrase(input.passphrase);
  encrypter.setScryptWorkFactor(input.workFactor ?? HOUSTON_TRANSFER_LIMITS.exportWorkFactor);
  const sealed = await encrypter.encrypt(
    NodeStream.Readable.toWeb(gzip) as unknown as ReadableStream<Uint8Array>,
  );
  const partial = `${input.file}.partial-${NodeCrypto.randomUUID()}`;
  const handle = await NodeFSP.open(partial, "wx");
  const reader = sealed.getReader();
  let bytes = 0;
  try {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > limits.fileBytes) {
          await reader.cancel();
          throw tooLarge(limits.fileBytes, input.entries);
        }
        await handle.write(next.value);
      }
    } finally {
      await handle.close();
    }
    await NodeFSP.rename(partial, input.file);
    return { bytes };
  } catch (error) {
    gzip.destroy();
    await NodeFSP.rm(partial, { force: true });
    throw error;
  }
};

// Reading.

/** Buffers a byte stream so frames can be read by length; chunks are kept, not re-concatenated. */
class ByteReader {
  private chunks: Array<Buffer> = [];
  private length = 0;
  private ended = false;
  private readonly source: AsyncIterator<Uint8Array>;
  constructor(source: AsyncIterator<Uint8Array>) {
    this.source = source;
  }

  private async fill(wanted: number) {
    while (this.length < wanted && !this.ended) {
      const next = await this.source.next();
      if (next.done === true) this.ended = true;
      else if (next.value.length > 0) {
        const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.length);
        this.chunks.push(chunk);
        this.length += chunk.length;
      }
    }
  }

  private shift(count: number) {
    const taken = Buffer.concat(this.chunks, Math.min(count, this.length)).subarray(0, count);
    let rest = count;
    while (rest > 0 && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      if (first.length <= rest) {
        this.chunks.shift();
        rest -= first.length;
      } else {
        this.chunks[0] = first.subarray(rest);
        rest = 0;
      }
    }
    this.length -= taken.length;
    return taken;
  }

  /** Up to `count` bytes without consuming them. */
  async peek(count: number) {
    await this.fill(count);
    return Buffer.concat(this.chunks, this.length).subarray(0, count);
  }

  /** Exactly `count` bytes, or null when the stream ends first. */
  async exact(count: number) {
    await this.fill(count);
    return this.length < count ? null : this.shift(count);
  }

  /** `count` bytes as they arrive; ends early only when the stream does. */
  async *take(count: number): AsyncGenerator<Buffer> {
    let rest = count;
    while (rest > 0) {
      if (this.length === 0) await this.fill(1);
      if (this.length === 0) return;
      const piece = this.shift(Math.min(rest, this.chunks[0]!.length));
      rest -= piece.length;
      yield piece;
    }
  }

  async atEnd() {
    await this.fill(1);
    return this.length === 0;
  }
}

export type MakeDecrypter = (passphrase: string) => {
  readonly decrypt: (file: ReadableStream<Uint8Array>) => Promise<ReadableStream<Uint8Array>>;
};

const defaultDecrypter: MakeDecrypter = (passphrase) => {
  const decrypter = new Decrypter();
  decrypter.addPassphrase(passphrase);
  return decrypter;
};

export interface ReadOptions {
  readonly limits?: Partial<FormatLimits>;
  readonly operation?: string;
  readonly onFrame?: (name: string) => void;
  /** Builds the age decrypter; a test counts how often a key derivation could start. */
  readonly decrypter?: MakeDecrypter;
}

/** The age header's stanzas, checked before anything derives a key from the passphrase. */
const checkHeader = async (file: string, operation: string) => {
  const handle = await NodeFSP.open(file, "r").catch(() => {
    throw refusal("not_found", operation, `No file exists at ${file}.`, {
      items: [file],
      steps: ["Choose the transfer file again."],
    });
  });
  const head = Buffer.alloc(MAX_HEADER_BYTES);
  let read = 0;
  try {
    read = (await handle.read(head, 0, head.length, 0)).bytesRead;
  } finally {
    await handle.close();
  }
  const text = head.subarray(0, read).toString("latin1");
  const end = text.indexOf("\n---");
  if (!text.startsWith("age-encryption.org/v1\n") || end < 0) {
    throw notTransferFile(operation, "The file is not a Houston transfer file.");
  }
  const stanzas = text
    .slice(0, end)
    .split("\n")
    .filter((line) => line.startsWith("-> "))
    .map((line) => line.slice(3).split(" "));
  if (stanzas.length !== 1 || stanzas[0]![0] !== "scrypt") {
    throw notTransferFile(
      operation,
      "The file is encrypted to a key, not a passphrase, so Houston did not make it.",
    );
  }
  const workFactor = Number(stanzas[0]![2]);
  if (!/^[1-9][0-9]*$/.test(stanzas[0]![2] ?? "")) {
    throw notTransferFile(operation, "The file's passphrase settings are damaged.");
  }
  if (workFactor > HOUSTON_TRANSFER_LIMITS.maxWorkFactor) {
    throw refusal(
      "not_transfer_file",
      operation,
      `The file asks for a key derivation cost of 2^${workFactor}; Houston accepts at most 2^${HOUSTON_TRANSFER_LIMITS.maxWorkFactor}.`,
      {
        steps: ["Choose a file that Houston exported with Export transfer."],
        limit: HOUSTON_TRANSFER_LIMITS.maxWorkFactor,
        actual: workFactor,
      },
    );
  }
};

/** The decrypted, gunzipped plaintext as a byte reader. */
const openPlaintext = async (file: string, passphrase: string, options: ReadOptions) => {
  const operation = options.operation ?? "houston.transfer.inspect";
  await checkHeader(file, operation);
  const source = NodeStream.Readable.toWeb(
    NodeFS.createReadStream(file),
  ) as unknown as ReadableStream<Uint8Array>;
  let decrypted: ReadableStream<Uint8Array>;
  try {
    decrypted = await (options.decrypter ?? defaultDecrypter)(passphrase).decrypt(source);
  } catch (error) {
    if (error instanceof Error && error.message.includes("no identity matched")) {
      throw refusal(
        "wrong_passphrase",
        operation,
        "The passphrase is wrong or the file is damaged.",
        {
          steps: ["Enter the passphrase used when the file was exported."],
        },
      );
    }
    throw notTransferFile(operation, "The file is not a Houston transfer file.");
  }
  // pipeline, not pipe: a failed chunk must reach the reader instead of leaving it waiting.
  const gunzip = NodeZlib.createGunzip();
  NodeStream.pipeline(NodeStream.Readable.fromWeb(decrypted as never), gunzip, () => undefined);
  return { reader: new ByteReader(gunzip[Symbol.asyncIterator]()), gunzip, operation };
};

/** Turns a stream failure (authentication, gzip, truncation) into a refusal naming `entry`. */
const guard = async <A>(operation: string, entry: string, body: () => Promise<A>): Promise<A> => {
  try {
    return await body();
  } catch (error) {
    if (isTransferError(error)) throw error;
    throw damaged(operation, [entry]);
  }
};

const isHouston1 = (head: Buffer) =>
  head.length >= 262 &&
  head.subarray(0, MANIFEST.length + 1).toString("latin1") === `${MANIFEST}\0` &&
  head.subarray(257, 262).toString("latin1") === "ustar";

const readFrameHeader = async (reader: ByteReader, operation: string, after: string) => {
  const lengthBytes = await reader.exact(4);
  if (lengthBytes === null) throw damaged(operation, [`(after ${after})`]);
  const nameLength = lengthBytes.readUInt32BE(0);
  if (nameLength === 0 || nameLength > MAX_NAME_BYTES) {
    throw damaged(operation, [`(after ${after})`]);
  }
  const nameBytes = await reader.exact(nameLength);
  const sizeBytes = await reader.exact(8);
  if (nameBytes === null || sizeBytes === null) throw damaged(operation, [`(after ${after})`]);
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
  } catch {
    throw damaged(operation, [`(after ${after})`]);
  }
  const size = sizeBytes.readBigUInt64BE(0);
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw damaged(operation, [name]);
  return { name, size: Number(size) };
};

/** Every name the manifest's fields point at, and the entries it lists, checked together. */
const validateManifest = (
  manifest: HoustonTransferManifest,
  limits: FormatLimits,
  operation: string,
) => {
  if (manifest.entries.length > limits.entries) {
    throw damaged(operation, [MANIFEST], {
      limit: limits.entries,
      actual: manifest.entries.length,
    });
  }
  const total = manifest.entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total > limits.unpackedBytes) {
    throw damaged(operation, [MANIFEST], { limit: limits.unpackedBytes, actual: total });
  }
  const folded = new Map<string, string>();
  for (const entry of manifest.entries) {
    const problem = entry.name === MANIFEST ? MANIFEST : entryNameProblem(entry.name);
    if (problem !== null) throw damaged(operation, [problem]);
    const first = folded.get(entry.name.toLowerCase());
    if (first !== undefined) {
      throw damaged(operation, [`${entry.name} and ${first} differ only in letter case`]);
    }
    folded.set(entry.name.toLowerCase(), entry.name);
  }
  // An entry cannot be both a file and the folder of another entry.
  for (const entry of manifest.entries) {
    const parts = entry.name.toLowerCase().split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const file = folded.get(parts.slice(0, depth).join("/"));
      if (file !== undefined) {
        throw damaged(operation, [`${file} is also the folder of ${entry.name}`]);
      }
    }
  }
  const listed = new Set(manifest.entries.map((entry) => entry.name));
  const named = (name: string, under: string) => {
    if (!listed.has(name) || !name.startsWith(`${under}/`)) throw damaged(operation, [name]);
  };
  const keys = new Set<string>();
  for (const checkout of manifest.checkouts) {
    if (keys.has(checkout.key)) throw damaged(operation, [checkout.key]);
    keys.add(checkout.key);
    if (checkout.bundle !== null) named(checkout.bundle, checkout.archiveDir);
    if (checkout.diff !== null) named(checkout.diff, checkout.archiveDir);
    for (const path of checkout.untracked) {
      if (pathProblem(path) !== null) throw damaged(operation, [path]);
      named(`${checkout.archiveDir}/untracked/${path}`, checkout.archiveDir);
    }
  }
  for (const thread of manifest.threads) {
    if (!keys.has(thread.checkout)) throw damaged(operation, [thread.archiveDir]);
    if (thread.relCwd !== "" && pathProblem(thread.relCwd) !== null) {
      throw damaged(operation, [thread.relCwd]);
    }
    named(`${thread.archiveDir}/thread.json`, thread.archiveDir);
    named(`${thread.archiveDir}/history.ndjson`, thread.archiveDir);
    for (const attachment of thread.attachments) {
      named(attachment, `${thread.archiveDir}/attachments`);
    }
  }
  for (const section of Object.values(manifest.sections)) named(section.archivePath, "sections");
};

/** Reads the magic line and the manifest frame, refusing anything else first. */
const readManifestFrame = async (
  reader: ByteReader,
  operation: string,
  options: ReadOptions,
  limits: FormatLimits,
) => {
  const head = await guard(operation, "(the start of the file)", () => reader.peek(512));
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) {
    if (isHouston1(head)) {
      throw refusal(
        "houston1_file",
        operation,
        "This file was made by Houston 1, which used terminal panes. This version imports files made by Houston 2.",
        {
          steps: [
            "Import it with Houston 1 on this computer, or export the workspace again from Houston 2 on the computer that made it.",
          ],
        },
      );
    }
    throw damaged(operation, ["(the start of the file)"]);
  }
  await reader.exact(MAGIC.length);
  const frame = await guard(operation, MANIFEST, () =>
    readFrameHeader(reader, operation, "the magic line"),
  );
  options.onFrame?.(frame.name);
  if (frame.name !== MANIFEST) throw damaged(operation, [frame.name]);
  if (frame.size > limits.manifestBytes) {
    throw damaged(operation, [MANIFEST], { limit: limits.manifestBytes, actual: frame.size });
  }
  const bytes = await guard(operation, MANIFEST, () => reader.exact(frame.size));
  if (bytes === null) throw damaged(operation, [MANIFEST]);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw damaged(operation, [MANIFEST]);
  }
  const format = (json as { readonly format?: unknown } | null)?.format;
  if (format !== HOUSTON_TRANSFER_FORMAT) {
    const named = format === undefined ? "(none)" : JSON.stringify(format);
    throw refusal(
      "unknown_format",
      operation,
      `The file has transfer format ${named}; this version reads format ${HOUSTON_TRANSFER_FORMAT}.`,
      { steps: ["Open the file with the Houston version that made it, or export it again."] },
    );
  }
  const decoded = decodeHoustonTransferManifest(json);
  if (decoded._tag === "Failure") throw damaged(operation, [MANIFEST]);
  validateManifest(decoded.value, limits, operation);
  return decoded.value;
};

/** The manifest alone; the rest is decrypted but not parsed, so a cut file is still refused. */
export const readManifest = async (
  file: string,
  passphrase: string,
  options: ReadOptions = {},
): Promise<HoustonTransferManifest> => {
  const limits = limitsOf(options.limits);
  const { reader, gunzip, operation } = await openPlaintext(file, passphrase, options);
  try {
    const manifest = await readManifestFrame(reader, operation, options, limits);
    await guard(operation, `(after ${MANIFEST})`, async () => {
      let rest = 0;
      for await (const piece of reader.take(Number.MAX_SAFE_INTEGER)) {
        rest += piece.length;
        if (rest > limits.unpackedBytes + limits.entries * (MAX_NAME_BYTES + 12)) {
          throw damaged(operation, [`(after ${MANIFEST})`]);
        }
      }
    });
    return manifest;
  } finally {
    gunzip.destroy();
  }
};

/** Checks each entry against the manifest and writes it below `scratch`, removed on refusal. */
export const unpackTransfer = async (
  file: string,
  passphrase: string,
  scratch: string,
  options: ReadOptions = {},
): Promise<HoustonTransferManifest> => {
  const limits = limitsOf(options.limits);
  const { reader, gunzip, operation } = await openPlaintext(file, passphrase, options);
  let created = false;
  try {
    const manifest = await readManifestFrame(reader, operation, options, limits);
    const expected = new Map(manifest.entries.map((entry) => [entry.name, entry]));
    const seen = new Set<string>();
    await NodeFSP.mkdir(scratch, { recursive: true, mode: 0o700 });
    created = true;
    let last = MANIFEST;
    for (;;) {
      if (await guard(operation, `(after ${last})`, () => reader.atEnd())) break;
      const frame = await guard(operation, `(after ${last})`, () =>
        readFrameHeader(reader, operation, last),
      );
      options.onFrame?.(frame.name);
      const entry = expected.get(frame.name);
      if (entry === undefined || seen.has(frame.name) || entry.size !== frame.size) {
        throw damaged(operation, [frame.name]);
      }
      seen.add(frame.name);
      const target = NodePath.join(scratch, ...frame.name.split("/"));
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      const hash = NodeCrypto.createHash("sha256");
      const handle = await NodeFSP.open(target, "wx");
      let written = 0;
      try {
        await guard(operation, frame.name, async () => {
          for await (const piece of reader.take(frame.size)) {
            hash.update(piece);
            written += piece.length;
            await handle.write(piece);
          }
        });
      } finally {
        await handle.close();
      }
      if (written !== frame.size || hash.digest("hex") !== entry.sha256) {
        throw damaged(operation, [frame.name]);
      }
      last = frame.name;
    }
    const missing = manifest.entries.find((entry) => !seen.has(entry.name));
    if (missing !== undefined) throw damaged(operation, [missing.name]);
    return manifest;
  } catch (error) {
    if (created) await NodeFSP.rm(scratch, { recursive: true, force: true });
    throw error;
  } finally {
    gunzip.destroy();
  }
};

/** The whole gunzipped plaintext, for tests that look inside a file. */
export const decryptPlaintext = async (file: string, passphrase: string) => {
  const { reader, gunzip } = await openPlaintext(file, passphrase, {});
  try {
    const pieces: Array<Buffer> = [];
    for await (const piece of reader.take(Number.MAX_SAFE_INTEGER)) pieces.push(piece);
    return Buffer.concat(pieces);
  } finally {
    gunzip.destroy();
  }
};

/** The frames of a plaintext held in memory, after its magic line. */
export const readFrames = (plaintext: Uint8Array) => {
  const bytes = Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.length);
  const frames: Array<{ readonly name: string; readonly bytes: Buffer }> = [];
  let offset = MAGIC.length;
  while (offset < bytes.length) {
    const nameLength = bytes.readUInt32BE(offset);
    const name = bytes.subarray(offset + 4, offset + 4 + nameLength).toString("utf8");
    const size = Number(bytes.readBigUInt64BE(offset + 4 + nameLength));
    const start = offset + 4 + nameLength + 8;
    frames.push({ name, bytes: bytes.subarray(start, start + size) });
    offset = start + size;
  }
  return frames;
};

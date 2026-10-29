// Houston's binary terminal frames, matching the Rust encoders in
// core/houston-protocol byte for byte (protocol/protocol.md, "Binary frames").
// All multi-byte integers are big-endian; u64 fields are bigint.

export const FRAME_OUTPUT = 1;
export const FRAME_STDIN = 2;
export const FRAME_GAP = 3;

export const FRAME_OUTPUT_HEADER_LEN = 13;
export const FRAME_STDIN_HEADER_LEN = 5;
export const FRAME_GAP_LEN = 21;

const KIND_NAMES: Record<number, string> = {
  [FRAME_OUTPUT]: "OUTPUT",
  [FRAME_STDIN]: "STDIN",
  [FRAME_GAP]: "GAP",
};

const SERVER_KINDS = [FRAME_OUTPUT, FRAME_GAP];
const CLIENT_KINDS = [FRAME_STDIN];

const MAX_U32 = 0xffffffff;
const MAX_U64 = 2n ** 64n - 1n;

export class TerminalFrameError extends Error {
  /** The frame's kind byte, or null when the bytes are too short to hold one. */
  readonly kind: number | null;
  readonly actualLength: number;
  readonly expectedLength: number | null;

  constructor(
    message: string,
    options: { kind: number | null; actualLength: number; expectedLength: number | null },
  ) {
    super(message);
    this.name = "TerminalFrameError";
    this.kind = options.kind;
    this.actualLength = options.actualLength;
    this.expectedLength = options.expectedLength;
  }
}

export type OutputFrame = {
  kind: typeof FRAME_OUTPUT;
  handle: number;
  offset: bigint;
  payload: Uint8Array;
};

export type GapFrame = {
  kind: typeof FRAME_GAP;
  handle: number;
  bytesSeen: bigint;
  dropped: bigint;
};

export type StdinFrame = {
  kind: typeof FRAME_STDIN;
  handle: number;
  payload: Uint8Array;
};

/** Frames a server may send: OUTPUT and GAP. */
export type ServerFrame = OutputFrame | GapFrame;

function kindLabel(kind: number): string {
  return `${kind} ${KIND_NAMES[kind] ?? "UNKNOWN"}`;
}

function kindList(kinds: number[]): string {
  return kinds.map(kindLabel).join(", ");
}

function fail(
  message: string,
  kind: number | null,
  actualLength: number,
  expectedLength: number | null,
): TerminalFrameError {
  return new TerminalFrameError(message, { kind, actualLength, expectedLength });
}

function assertHandle(handle: number): void {
  if (!Number.isInteger(handle) || handle < 0 || handle > MAX_U32) {
    throw new RangeError(
      `terminal frame handle must be an integer in [0, ${MAX_U32}]; got ${handle}`,
    );
  }
}

function assertUnsigned64(value: bigint, field: string): void {
  if (value < 0n || value > MAX_U64) {
    throw new RangeError(`terminal frame ${field} must be an integer in [0, 2^64); got ${value}`);
  }
}

function writeHeader(view: DataView, kind: number, handle: number): void {
  view.setUint8(0, kind);
  view.setUint32(1, handle, false);
}

export function encodeOutputFrame(input: {
  handle: number;
  offset: bigint;
  payload: Uint8Array;
}): Uint8Array {
  assertHandle(input.handle);
  assertUnsigned64(input.offset, "offset");
  const bytes = new Uint8Array(FRAME_OUTPUT_HEADER_LEN + input.payload.length);
  const view = new DataView(bytes.buffer);
  writeHeader(view, FRAME_OUTPUT, input.handle);
  view.setBigUint64(5, input.offset, false);
  bytes.set(input.payload, FRAME_OUTPUT_HEADER_LEN);
  return bytes;
}

export function encodeStdinFrame(input: { handle: number; payload: Uint8Array }): Uint8Array {
  assertHandle(input.handle);
  const bytes = new Uint8Array(FRAME_STDIN_HEADER_LEN + input.payload.length);
  const view = new DataView(bytes.buffer);
  writeHeader(view, FRAME_STDIN, input.handle);
  bytes.set(input.payload, FRAME_STDIN_HEADER_LEN);
  return bytes;
}

export function encodeGapFrame(input: {
  handle: number;
  bytesSeen: bigint;
  dropped: bigint;
}): Uint8Array {
  assertHandle(input.handle);
  assertUnsigned64(input.bytesSeen, "bytesSeen");
  assertUnsigned64(input.dropped, "dropped");
  const bytes = new Uint8Array(FRAME_GAP_LEN);
  const view = new DataView(bytes.buffer);
  writeHeader(view, FRAME_GAP, input.handle);
  view.setBigUint64(5, input.bytesSeen, false);
  view.setBigUint64(13, input.dropped, false);
  return bytes;
}

function kindByte(
  bytes: Uint8Array,
  acceptedKinds: number[],
  decoder: "decodeServerFrame" | "decodeClientFrame",
): number {
  if (bytes.length < 1) {
    throw fail("Terminal frame is 0 bytes; it needs a kind byte", null, 0, 1);
  }
  const kind = bytes[0]!;
  if (!(kind in KIND_NAMES)) {
    throw fail(
      `Unknown terminal frame kind 0x${kind.toString(16).padStart(2, "0")} (${kind}); accepted kinds: ${kindList([FRAME_OUTPUT, FRAME_STDIN, FRAME_GAP])}`,
      kind,
      bytes.length,
      null,
    );
  }
  if (!acceptedKinds.includes(kind)) {
    throw fail(
      `${decoder} accepts ${decoder === "decodeServerFrame" ? "server" : "client"} frames only (${kindList(acceptedKinds)}); got ${kindLabel(kind)}`,
      kind,
      bytes.length,
      null,
    );
  }
  return kind;
}

export function decodeServerFrame(bytes: Uint8Array): ServerFrame {
  const kind = kindByte(bytes, SERVER_KINDS, "decodeServerFrame");
  if (kind === FRAME_GAP && bytes.length !== FRAME_GAP_LEN) {
    throw fail(
      `GAP frame is ${bytes.length} bytes; it must be exactly ${FRAME_GAP_LEN} bytes`,
      kind,
      bytes.length,
      FRAME_GAP_LEN,
    );
  }
  if (bytes.length < FRAME_OUTPUT_HEADER_LEN) {
    throw fail(
      `${KIND_NAMES[kind]} frame is ${bytes.length} bytes; header needs ${FRAME_OUTPUT_HEADER_LEN}`,
      kind,
      bytes.length,
      FRAME_OUTPUT_HEADER_LEN,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const handle = view.getUint32(1, false);
  if (kind === FRAME_GAP) {
    return {
      kind: FRAME_GAP,
      handle,
      bytesSeen: view.getBigUint64(5, false),
      dropped: view.getBigUint64(13, false),
    };
  }
  return {
    kind: FRAME_OUTPUT,
    handle,
    offset: view.getBigUint64(5, false),
    payload: bytes.slice(FRAME_OUTPUT_HEADER_LEN),
  };
}

export function decodeClientFrame(bytes: Uint8Array): StdinFrame {
  const kind = kindByte(bytes, CLIENT_KINDS, "decodeClientFrame");
  if (bytes.length < FRAME_STDIN_HEADER_LEN) {
    throw fail(
      `STDIN frame is ${bytes.length} bytes; header needs ${FRAME_STDIN_HEADER_LEN}`,
      kind,
      bytes.length,
      FRAME_STDIN_HEADER_LEN,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    kind: FRAME_STDIN,
    handle: view.getUint32(1, false),
    payload: bytes.slice(FRAME_STDIN_HEADER_LEN),
  };
}

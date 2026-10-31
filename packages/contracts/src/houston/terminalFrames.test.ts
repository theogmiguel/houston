import { describe, expect, it } from "vite-plus/test";

import {
  decodeClientFrame,
  decodeServerFrame,
  encodeGapFrame,
  encodeOutputFrame,
  encodeStdinFrame,
  TerminalFrameError,
} from "./terminalFrames.ts";

// Literal byte vectors shared with houston-protocol's `shared_frame_vectors`
// Rust test in core/houston-protocol/src/lib.rs; change both together.
const HEX = {
  output: "01ffffffff00000100000000076869",
  stdin: "02ffffffff6869",
  gap: "030000000780000000000000008000000000000000",
  gapDistinct: "030102030400000000000000010000000000000002",
};

const ENCODER = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function frameError(run: () => unknown): TerminalFrameError {
  try {
    run();
  } catch (error) {
    if (error instanceof TerminalFrameError) return error;
    throw error;
  }
  throw new Error("expected the call to throw TerminalFrameError");
}

describe("terminalFrames", () => {
  it("encodeOutputFrame returns 13 plus payload bytes in the houston layout", () => {
    const bytes = encodeOutputFrame({
      handle: 0xffffffff,
      offset: 2n ** 40n + 7n,
      payload: ENCODER.encode("hi"),
    });
    expect(bytes.length).toBe(13 + 2);
    expect(hex(bytes)).toBe(HEX.output);
  });

  it("encodeStdinFrame returns 5 plus payload bytes in the houston layout", () => {
    const bytes = encodeStdinFrame({ handle: 0xffffffff, payload: ENCODER.encode("hi") });
    expect(bytes.length).toBe(5 + 2);
    expect(hex(bytes)).toBe(HEX.stdin);
  });

  it("encodeGapFrame returns exactly 21 bytes in the houston layout", () => {
    const bytes = encodeGapFrame({ handle: 7, bytesSeen: 2n ** 63n, dropped: 2n ** 63n });
    expect(bytes.length).toBe(21);
    expect(hex(bytes)).toBe(HEX.gap);
  });

  it("gap fields bytesSeen and dropped sit at their own offsets", () => {
    const bytes = encodeGapFrame({ handle: 0x01020304, bytesSeen: 1n, dropped: 2n });
    expect(hex(bytes)).toBe(HEX.gapDistinct);
    expect(decodeServerFrame(fromHex(HEX.gapDistinct))).toEqual({
      kind: 3,
      handle: 0x01020304,
      bytesSeen: 1n,
      dropped: 2n,
    });
  });

  it("range guard accepts the bounds of handle and offset", () => {
    const low = encodeOutputFrame({ handle: 0, offset: 0n, payload: new Uint8Array(0) });
    expect(hex(low)).toBe("0100000000" + "00".repeat(8));
    const high = encodeOutputFrame({
      handle: 2 ** 32 - 1,
      offset: 2n ** 64n - 1n,
      payload: new Uint8Array(0),
    });
    expect(hex(high)).toBe("01ffffffff" + "ff".repeat(8));
  });

  it("range guard rejects a handle outside [0, 2^32) naming the field and value", () => {
    const payload = new Uint8Array(0);
    for (const [handle, shown] of [
      [2 ** 32, "4294967296"],
      [-1, "-1"],
      [1.5, "1.5"],
    ] as const) {
      expect(() => encodeOutputFrame({ handle, offset: 0n, payload })).toThrow(
        new RangeError(
          `terminal frame handle must be an integer in [0, 4294967295]; got ${shown}`,
        ),
      );
      expect(() => encodeStdinFrame({ handle, payload })).toThrow(RangeError);
      expect(() => encodeGapFrame({ handle, bytesSeen: 0n, dropped: 0n })).toThrow(RangeError);
    }
  });

  it("range guard rejects an offset outside [0, 2^64) naming the field and value", () => {
    const payload = new Uint8Array(0);
    expect(() => encodeOutputFrame({ handle: 0, offset: 2n ** 64n, payload })).toThrow(
      new RangeError(
        "terminal frame offset must be an integer in [0, 2^64); got 18446744073709551616",
      ),
    );
    expect(() => encodeOutputFrame({ handle: 0, offset: -1n, payload })).toThrow(
      new RangeError("terminal frame offset must be an integer in [0, 2^64); got -1"),
    );
  });

  it("range guard rejects gap counters outside [0, 2^64) naming the field and value", () => {
    expect(() => encodeGapFrame({ handle: 0, bytesSeen: 2n ** 64n, dropped: 0n })).toThrow(
      new RangeError(
        "terminal frame bytesSeen must be an integer in [0, 2^64); got 18446744073709551616",
      ),
    );
    expect(() => encodeGapFrame({ handle: 0, bytesSeen: 0n, dropped: -1n })).toThrow(
      new RangeError("terminal frame dropped must be an integer in [0, 2^64); got -1"),
    );
  });

  it("decodeServerFrame decodes OUTPUT and GAP with bigint fields", () => {
    const output = decodeServerFrame(fromHex(HEX.output));
    expect(output).toEqual({
      kind: 1,
      handle: 0xffffffff,
      offset: 2n ** 40n + 7n,
      payload: ENCODER.encode("hi"),
    });

    const gap = decodeServerFrame(fromHex(HEX.gap));
    expect(gap).toEqual({
      kind: 3,
      handle: 7,
      bytesSeen: 2n ** 63n,
      dropped: 2n ** 63n,
    });
  });

  it("decodeServerFrame rejects a short frame and accepts an empty payload", () => {
    const short = new Uint8Array(12);
    short[0] = 1;
    const error = frameError(() => decodeServerFrame(short));
    expect(error.message).toBe("OUTPUT frame is 12 bytes; header needs 13");
    expect(error.kind).toBe(1);
    expect(error.actualLength).toBe(12);
    expect(error.expectedLength).toBe(13);

    const headerOnly = new Uint8Array(13);
    headerOnly[0] = 1;
    expect(decodeServerFrame(headerOnly)).toEqual({
      kind: 1,
      handle: 0,
      offset: 0n,
      payload: new Uint8Array(0),
    });
  });

  it("decodeServerFrame gap length must be exactly 21 bytes", () => {
    const tooLong = new Uint8Array(22);
    tooLong[0] = 3;
    const error = frameError(() => decodeServerFrame(tooLong));
    expect(error.message).toBe("GAP frame is 22 bytes; it must be exactly 21 bytes");
    expect(error.kind).toBe(3);
    expect(error.actualLength).toBe(22);
    expect(error.expectedLength).toBe(21);

    const exact = new Uint8Array(21);
    exact[0] = 3;
    expect(decodeServerFrame(exact)).toEqual({
      kind: 3,
      handle: 0,
      bytesSeen: 0n,
      dropped: 0n,
    });
  });

  it("decodeServerFrame unknown kind names the byte and the accepted kinds", () => {
    const error = frameError(() => decodeServerFrame(new Uint8Array(13)));
    expect(error.message).toBe(
      "Unknown terminal frame kind 0x00 (0); accepted kinds: 1 OUTPUT, 2 STDIN, 3 GAP",
    );
    expect(error.kind).toBe(0);

    const stdin = new Uint8Array(7);
    stdin[0] = 2;
    const serverError = frameError(() => decodeServerFrame(stdin));
    expect(serverError.message).toBe(
      "decodeServerFrame accepts server frames only (1 OUTPUT, 3 GAP); got 2 STDIN",
    );
    expect(serverError.kind).toBe(2);
  });

  it("client frame pairs with encodeGapFrame, which is exactly 21 bytes at any counter", () => {
    const widest = encodeGapFrame({ handle: 2 ** 32 - 1, bytesSeen: 2n ** 64n - 1n, dropped: 0n });
    expect(widest.length).toBe(21);
    expect(encodeGapFrame({ handle: 0, bytesSeen: 0n, dropped: 0n }).length).toBe(21);
  });

  it("client frame decodes a 5-byte STDIN with an empty payload", () => {
    const headerOnly = new Uint8Array(5);
    headerOnly[0] = 2;
    expect(decodeClientFrame(headerOnly)).toEqual({
      kind: 2,
      handle: 0,
      payload: new Uint8Array(0),
    });
  });

  it("client frame rejects 4 bytes naming 4 and 5", () => {
    const short = new Uint8Array(4);
    short[0] = 2;
    const error = frameError(() => decodeClientFrame(short));
    expect(error.message).toBe("STDIN frame is 4 bytes; header needs 5");
    expect(error.kind).toBe(2);
    expect(error.actualLength).toBe(4);
    expect(error.expectedLength).toBe(5);
  });

  it("client frame rejects the OUTPUT and GAP kinds", () => {
    const output = new Uint8Array(13);
    output[0] = 1;
    expect(frameError(() => decodeClientFrame(output)).message).toBe(
      "decodeClientFrame accepts client frames only (2 STDIN); got 1 OUTPUT",
    );
    const gap = new Uint8Array(21);
    gap[0] = 3;
    const error = frameError(() => decodeClientFrame(gap));
    expect(error.message).toBe(
      "decodeClientFrame accepts client frames only (2 STDIN); got 3 GAP",
    );
    expect(error.kind).toBe(3);
  });

  it("decodeClientFrame decodes STDIN and rejects server frames", () => {
    const payload = ENCODER.encode("hi");
    const decoded = decodeClientFrame(encodeStdinFrame({ handle: 7, payload }));
    expect(decoded.kind).toBe(2);
    expect(decoded.handle).toBe(7);
    expect([...decoded.payload]).toEqual([...payload]);

    const output = new Uint8Array(13);
    output[0] = 1;
    const error = frameError(() => decodeClientFrame(output));
    expect(error.message).toBe(
      "decodeClientFrame accepts client frames only (2 STDIN); got 1 OUTPUT",
    );
    expect(error.kind).toBe(1);
  });
});

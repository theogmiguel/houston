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

  it("decodeServerFrame decodes OUTPUT and GAP with bigint fields", () => {
    const output = decodeServerFrame(fromHex(HEX.output));
    expect(output.kind).toBe(1);
    expect(output.handle).toBe(0xffffffff);
    expect(output.offset).toBe(2n ** 40n + 7n);
    expect([...output.payload]).toEqual([...ENCODER.encode("hi")]);

    const gap = decodeServerFrame(fromHex(HEX.gap));
    expect(gap.kind).toBe(3);
    expect(gap.handle).toBe(7);
    expect(gap.bytesSeen).toBe(2n ** 63n);
    expect(gap.dropped).toBe(2n ** 63n);
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
    const empty = decodeServerFrame(headerOnly);
    expect(empty.kind).toBe(1);
    expect(empty.offset).toBe(0n);
    expect(empty.payload.length).toBe(0);
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
    const frame = decodeServerFrame(exact);
    expect(frame.kind).toBe(3);
    expect(frame.bytesSeen).toBe(0n);
    expect(frame.dropped).toBe(0n);
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

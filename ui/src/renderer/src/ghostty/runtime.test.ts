// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GhosttyRuntime } from "./runtime";

function buildStubModule(): Uint8Array<ArrayBuffer> {
  const layouts = JSON.stringify({
    GhosttyStyle: { size: 8, align: 1, fields: { bold: { offset: 4, size: 1, type: "bool" } } },
  });
  const json = new TextEncoder().encode(layouts + "\0");

  const bytes: number[] = [];
  const push = (...b: number[]): void => {
    bytes.push(...b);
  };
  const uleb = (n: number): number[] => {
    const out: number[] = [];
    do {
      let byte = n & 0x7f;
      n >>>= 7;
      if (n !== 0) byte |= 0x80;
      out.push(byte);
    } while (n !== 0);
    return out;
  };
  const section = (id: number, payload: number[]): void => {
    push(id, ...uleb(payload.length), ...payload);
  };

  push(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

  section(1, [0x01, 0x60, 0x00, 0x01, 0x7f]);
  section(3, [0x01, 0x00]);
  section(5, [0x01, 0x01, 0x01, 0x02]);
  const name = (s: string): number[] => {
    const enc = new TextEncoder().encode(s);
    return [...uleb(enc.length), ...enc];
  };
  section(7, [
    0x02,
    ...name("memory"),
    0x02,
    0x00,
    ...name("ghostty_type_json"),
    0x00,
    0x00,
  ]);
  const body = [0x00, 0x41, ...uleb(16), 0x0b];
  section(10, [0x01, ...uleb(body.length), ...body]);
  section(11, [0x01, 0x00, 0x41, ...uleb(16), 0x0b, ...uleb(json.length), ...json]);

  return new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
}

function stubInstance(): WebAssembly.Instance {
  return new WebAssembly.Instance(new WebAssembly.Module(buildStubModule()), {});
}

async function stubRuntime(): Promise<GhosttyRuntime> {
  const instance = stubInstance();
  const exports = new Proxy(instance.exports, {
    get: (target, key: string) => (key in target ? target[key] : () => 0),
  });
  const ctor = GhosttyRuntime as unknown as new (i: WebAssembly.Instance) => GhosttyRuntime;
  return new ctor({ exports } as WebAssembly.Instance);
}

describe("GhosttyRuntime cached views", () => {
  it("hands back views over the CURRENT buffer after memory growth", async () => {
    const runtime = await stubRuntime();

    runtime.u8()[64] = 0xab;
    expect(runtime.dv().getUint8(64)).toBe(0xab);
    const before = runtime.u8();
    expect(before.byteLength).toBeGreaterThan(0);

    runtime.memory.grow(1);
    expect(before.byteLength).toBe(0);

    const after = runtime.u8();
    expect(after === before).toBe(false);
    expect(after.byteLength).toBe(2 * 65536);
    expect(runtime.dv().buffer === runtime.memory.buffer).toBe(true);

    expect(runtime.u8()[64]).toBe(0xab);
    expect(runtime.dv().getUint8(64)).toBe(0xab);
  });

  it("zero() and copyInto() also refresh after growth", async () => {
    const runtime = await stubRuntime();
    runtime.u8().fill(0xff, 64, 96);
    runtime.memory.grow(1);

    runtime.zero(64, 4);
    expect(Array.from(runtime.u8().subarray(64, 68))).toEqual([0, 0, 0, 0]);

    runtime.copyInto(80, new Uint8Array([1, 2, 3]));
    expect(Array.from(runtime.u8().subarray(80, 83))).toEqual([1, 2, 3]);
  });

  it("field() memoises a descriptor without changing what it reports", async () => {
    const runtime = await stubRuntime();
    const first = runtime.field("GhosttyStyle", "bold");
    const second = runtime.field("GhosttyStyle", "bold");
    expect(second).toBe(first);
    expect(first).toEqual(runtime.layout("GhosttyStyle").fields.bold);

    runtime.u8()[128 + first.offset] = 1;
    expect(runtime.readFieldAt(128, first)).toBe(1);
    expect(runtime.readField(128, "GhosttyStyle", "bold")).toBe(1);
  });

  it("names the struct and field when a descriptor does not exist", async () => {
    const runtime = await stubRuntime();
    expect(() => runtime.field("GhosttyStyle", "nope")).toThrow(/GhosttyStyle\.nope/);
  });

  it("names the missing export when a hot one is absent, at construction", async () => {
    const ctor = GhosttyRuntime as unknown as new (i: WebAssembly.Instance) => GhosttyRuntime;
    expect(() => new ctor(stubInstance())).toThrow(
      "libghostty-vt export is unavailable: ghostty_render_state_update",
    );
  });
});

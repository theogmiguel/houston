import ghosttyWasmUrl from "./vendor/ghostty-vt.wasm?url";
import ghosttyWritePtyWasmUrl from "./vendor/ghostty-write-pty.wasm?url&no-inline";

type WasmFunction = (...args: Array<number | bigint>) => number;

export interface TypeField {
  readonly offset: number;
  readonly size: number;
  readonly type: string;
}

interface TypeLayout {
  readonly size: number;
  readonly align: number;
  readonly fields: Readonly<Record<string, TypeField>>;
}

type TypeLayouts = Readonly<Record<string, TypeLayout>>;

const textDecoder = new TextDecoder();

export class GhosttyRuntime {
  readonly memory: WebAssembly.Memory;
  readonly layouts: TypeLayouts;
  private readonly exports: WebAssembly.Exports;
  private readonly ptyWriters = new Map<number, (data: string) => void>();
  private nextPtyWriterId = 1;
  private writePtyFunctionIndex = 0;

  private cachedBuffer: ArrayBuffer | null = null;
  private cachedView!: DataView;
  private cachedBytes!: Uint8Array;

  private refreshViews(): void {
    if (this.cachedBuffer === this.memory.buffer) return;
    this.cachedBuffer = this.memory.buffer;
    this.cachedView = new DataView(this.memory.buffer);
    this.cachedBytes = new Uint8Array(this.memory.buffer);
  }

  dv(): DataView {
    this.refreshViews();
    return this.cachedView;
  }

  u8(): Uint8Array {
    this.refreshViews();
    return this.cachedBytes;
  }

  zero(at: number, len: number): void {
    this.refreshViews();
    this.cachedBytes.fill(0, at, at + len);
  }

  copyInto(at: number, src: Uint8Array): void {
    this.refreshViews();
    this.cachedBytes.set(src, at);
  }

  readonly renderStateUpdate: (renderState: number, terminal: number) => number;
  readonly renderStateGet: (renderState: number, data: number, out: number) => number;
  readonly renderStateSet: (renderState: number, data: number, value: number) => number;
  readonly renderStateRowIteratorNext: (iterator: number) => number;
  readonly renderStateRowGet: (iterator: number, data: number, out: number) => number;
  readonly renderStateRowSet: (iterator: number, data: number, value: number) => number;
  readonly renderStateRowCellsNext: (iterator: number) => number;
  readonly renderStateRowCellsGet: (iterator: number, data: number, out: number) => number;
  readonly rowGet: (row: bigint, data: number, out: number) => number;
  readonly cellGet: (cell: bigint, data: number, out: number) => number;

  private bind<F>(name: string): F {
    const fn = this.exports[name];
    if (typeof fn !== "function") {
      throw new Error(`libghostty-vt export is unavailable: ${name}`);
    }
    return fn as F;
  }

  private constructor(instance: WebAssembly.Instance) {
    this.exports = instance.exports;
    const memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new Error("libghostty-vt did not export WebAssembly memory");
    }
    this.memory = memory;
    this.renderStateUpdate = this.bind("ghostty_render_state_update");
    this.renderStateGet = this.bind("ghostty_render_state_get");
    this.renderStateSet = this.bind("ghostty_render_state_set");
    this.renderStateRowIteratorNext = this.bind("ghostty_render_state_row_iterator_next");
    this.renderStateRowGet = this.bind("ghostty_render_state_row_get");
    this.renderStateRowSet = this.bind("ghostty_render_state_row_set");
    this.renderStateRowCellsNext = this.bind("ghostty_render_state_row_cells_next");
    this.renderStateRowCellsGet = this.bind("ghostty_render_state_row_cells_get");
    this.rowGet = this.bind("ghostty_row_get");
    this.cellGet = this.bind("ghostty_cell_get");
    const jsonPointer = this.call("ghostty_type_json");
    const bytes = new Uint8Array(memory.buffer);
    let end = jsonPointer;
    while (end < bytes.length && bytes[end] !== 0) end += 1;
    this.layouts = JSON.parse(textDecoder.decode(bytes.subarray(jsonPointer, end))) as TypeLayouts;
  }

  private static wasmImports(): {
    imports: WebAssembly.Imports;
    adopt: (instance: WebAssembly.Instance) => WebAssembly.Instance;
  } {
    let instance: WebAssembly.Instance | undefined;
    return {
      imports: {
        env: {
          log: (pointer: number, length: number) => {
            if (!instance) return;
            const memory = instance.exports.memory;
            if (!(memory instanceof WebAssembly.Memory)) return;
            const message = textDecoder.decode(new Uint8Array(memory.buffer, pointer, length));
            console.debug("[libghostty-vt]", message);
          },
        },
      },
      adopt: (adopted) => {
        instance = adopted;
        return adopted;
      },
    };
  }

  private static async instantiateModule(wasmBytes: BufferSource): Promise<WebAssembly.Instance> {
    const { imports, adopt } = GhosttyRuntime.wasmImports();
    return adopt((await WebAssembly.instantiate(wasmBytes, imports)).instance);
  }

  private static async instantiateResponse(response: Response): Promise<WebAssembly.Instance> {
    const { imports, adopt } = GhosttyRuntime.wasmImports();
    const contentType = response.headers.get("content-type") ?? "";
    if (
      typeof WebAssembly.instantiateStreaming === "function" &&
      contentType.startsWith("application/wasm")
    ) {
      return adopt((await WebAssembly.instantiateStreaming(response, imports)).instance);
    }
    return adopt((await WebAssembly.instantiate(await response.arrayBuffer(), imports)).instance);
  }

  static async load(): Promise<GhosttyRuntime> {
    const response = await fetch(ghosttyWasmUrl);
    if (!response.ok) {
      throw new Error(`Unable to load libghostty-vt (${response.status})`);
    }
    const instance = await GhosttyRuntime.instantiateResponse(response);
    const runtime = new GhosttyRuntime(instance);
    await runtime.installWritePtyTrampoline();
    return runtime;
  }

  static async loadFromBytes(
    wasmBytes: BufferSource,
    writePtyBytes: BufferSource,
  ): Promise<GhosttyRuntime> {
    const instance = await GhosttyRuntime.instantiateModule(wasmBytes);
    const runtime = new GhosttyRuntime(instance);
    await runtime.installWritePtyTrampolineFromBytes(writePtyBytes);
    return runtime;
  }

  call(name: string, ...args: Array<number | bigint>): number {
    const fn = this.exports[name];
    if (typeof fn !== "function") {
      throw new Error(`libghostty-vt export is unavailable: ${name}`);
    }
    return (fn as WasmFunction)(...args);
  }

  layout(name: string): TypeLayout {
    const layout = this.layouts[name];
    if (!layout) throw new Error(`libghostty-vt type layout is unavailable: ${name}`);
    return layout;
  }

  alloc(size: number): number {
    const pointer = this.call("ghostty_wasm_alloc_u8_array", size);
    if (pointer === 0) throw new Error(`libghostty-vt failed to allocate ${size} bytes`);
    this.zero(pointer, size);
    return pointer;
  }

  allocUninit(size: number): number {
    const pointer = this.call("ghostty_wasm_alloc_u8_array", size);
    if (pointer === 0) throw new Error(`libghostty-vt failed to allocate ${size} bytes`);
    return pointer;
  }

  free(pointer: number, size: number): void {
    if (pointer !== 0) this.call("ghostty_wasm_free_u8_array", pointer, size);
  }

  allocOpaque(): number {
    const pointer = this.call("ghostty_wasm_alloc_opaque");
    if (pointer === 0) throw new Error("libghostty-vt failed to allocate an opaque pointer");
    this.dv().setUint32(pointer, 0, true);
    return pointer;
  }

  freeOpaque(pointer: number): void {
    if (pointer !== 0) this.call("ghostty_wasm_free_opaque", pointer);
  }

  readPointer(slot: number): number {
    return this.dv().getUint32(slot, true);
  }

  private readonly fieldCache = new Map<string, TypeField>();

  field(structName: string, fieldName: string): TypeField {
    const key = `${structName}.${fieldName}`;
    const hit = this.fieldCache.get(key);
    if (hit) return hit;
    const field = this.layout(structName).fields[fieldName];
    if (!field) throw new Error(`libghostty-vt field is unavailable: ${structName}.${fieldName}`);
    this.fieldCache.set(key, field);
    return field;
  }

  readFieldAt(pointer: number, field: TypeField): number {
    const view = this.dv();
    const at = pointer + field.offset;
    switch (field.type) {
      case "bool":
      case "u8":
        return view.getUint8(at);
      case "u16":
        return view.getUint16(at, true);
      case "i32":
        return view.getInt32(at, true);
      case "u32":
      case "enum":
        return view.getUint32(at, true);
      case "u64":
        return Number(view.getBigUint64(at, true));
      default:
        throw new Error(`Unsupported libghostty-vt field type: ${field.type}`);
    }
  }

  setFieldAt(pointer: number, field: TypeField, value: number): void {
    const view = this.dv();
    const at = pointer + field.offset;
    switch (field.type) {
      case "bool":
      case "u8":
        view.setUint8(at, value);
        return;
      case "u16":
        view.setUint16(at, value, true);
        return;
      case "i32":
        view.setInt32(at, value, true);
        return;
      case "u32":
      case "enum":
        view.setUint32(at, value, true);
        return;
      case "u64":
        view.setBigUint64(at, BigInt(value), true);
        return;
      default:
        throw new Error(`Unsupported libghostty-vt field type: ${field.type}`);
    }
  }

  attachPtyWriter(terminal: number, writer: (data: string) => void): number {
    if (this.writePtyFunctionIndex === 0) {
      throw new Error("libghostty-vt PTY callback trampoline is unavailable");
    }
    const id = this.nextPtyWriterId++;
    this.ptyWriters.set(id, writer);
    this.call("ghostty_terminal_set", terminal, 0, id);
    this.call("ghostty_terminal_set", terminal, 1, this.writePtyFunctionIndex);
    return id;
  }

  detachPtyWriter(terminal: number, id: number): void {
    this.call("ghostty_terminal_set", terminal, 1, 0);
    this.call("ghostty_terminal_set", terminal, 0, 0);
    this.ptyWriters.delete(id);
  }

  view(pointer: number, size?: number): DataView {
    return new DataView(this.memory.buffer, pointer, size);
  }

  bytes(pointer: number, size: number): Uint8Array {
    return new Uint8Array(this.memory.buffer, pointer, size);
  }

  setField(pointer: number, structName: string, fieldName: string, value: number): void {
    const field = this.layout(structName).fields[fieldName];
    if (!field) throw new Error(`libghostty-vt field is unavailable: ${structName}.${fieldName}`);
    const view = this.view(pointer + field.offset, field.size);
    switch (field.type) {
      case "bool":
      case "u8":
        view.setUint8(0, value);
        return;
      case "u16":
        view.setUint16(0, value, true);
        return;
      case "i32":
        view.setInt32(0, value, true);
        return;
      case "u32":
      case "enum":
        view.setUint32(0, value, true);
        return;
      case "u64":
        view.setBigUint64(0, BigInt(value), true);
        return;
      default:
        throw new Error(`Unsupported libghostty-vt field type: ${field.type}`);
    }
  }

  readField(pointer: number, structName: string, fieldName: string): number {
    const field = this.layout(structName).fields[fieldName];
    if (!field) throw new Error(`libghostty-vt field is unavailable: ${structName}.${fieldName}`);
    const view = this.view(pointer + field.offset, field.size);
    switch (field.type) {
      case "bool":
      case "u8":
        return view.getUint8(0);
      case "u16":
        return view.getUint16(0, true);
      case "i32":
        return view.getInt32(0, true);
      case "u32":
      case "enum":
        return view.getUint32(0, true);
      case "u64":
        return Number(view.getBigUint64(0, true));
      default:
        throw new Error(`Unsupported libghostty-vt field type: ${field.type}`);
    }
  }

  private async installWritePtyTrampoline(): Promise<void> {
    const response = await fetch(ghosttyWritePtyWasmUrl);
    if (!response.ok) {
      throw new Error(`Unable to load the libghostty-vt PTY trampoline (${response.status})`);
    }
    await this.installWritePtyTrampolineFromBytes(await response.arrayBuffer());
  }

  private async installWritePtyTrampolineFromBytes(trampolineBytes: BufferSource): Promise<void> {
    const result = await WebAssembly.instantiate(trampolineBytes, {
      env: {
        t3_write_pty: (_terminal: number, userdata: number, pointer: number, length: number) => {
          const writer = this.ptyWriters.get(userdata);
          if (!writer || length === 0) return;
          writer(textDecoder.decode(new Uint8Array(this.memory.buffer, pointer, length)));
        },
      },
    });
    const trampoline = result.instance.exports.ghostty_write_pty;
    const table = this.exports.__indirect_function_table;
    if (typeof trampoline !== "function" || !(table instanceof WebAssembly.Table)) {
      throw new Error("libghostty-vt did not expose its callback table");
    }
    const index = table.length;
    table.grow(1);
    table.set(index, trampoline);
    this.writePtyFunctionIndex = index;
  }
}

let runtimePromise: Promise<GhosttyRuntime> | null = null;

export function loadGhosttyRuntime(): Promise<GhosttyRuntime> {
  runtimePromise ??= GhosttyRuntime.load().catch((error) => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

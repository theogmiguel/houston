import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createPreviewStreamClient,
  previewStreamHostSetupMessage,
  previewStreamInstallPercent,
  type PreviewStreamControl,
} from "./serverBrowserStream.ts";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.current = this;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  control(value: PreviewStreamControl) {
    this.message(JSON.stringify({ type: "control", ...value }));
  }
}

const target = {
  access: {
    httpBase: "http://preview.test/api/preview-stream",
    wsBase: "ws://preview.test/api/preview-stream",
    query: {},
    credentials: true,
  },
  threadId: "thread",
  tabId: "tab",
  maxWidth: 800,
  maxHeight: 600,
};

describe("preview stream control", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());
  const connect = () => {
    const onFrame = vi.fn();
    const onControl = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame,
      onControl,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    return { client, socket: FakeSocket.current, onFrame, onControl };
  };
  const agent: PreviewStreamControl = {
    canOperate: true,
    controller: "agent",
    generation: 1,
    dialog: null,
  };

  it("does not grant control from malformed dialog metadata", () => {
    const { client, socket, onControl } = connect();
    socket.message(
      JSON.stringify({
        type: "control",
        ...agent,
        controller: "you",
        dialog: { type: "prompt", message: 42, defaultValue: "" },
      }),
    );
    expect(onControl).not.toHaveBeenCalled();
    expect(client.send({ type: "reload" })).toBe(false);
    client.stop();
  });

  it("keeps read-only frames flowing while refusing takeover and every mutation", () => {
    const { client, socket, onFrame } = connect();
    socket.control({ ...agent, canOperate: false });
    const frame = new ArrayBuffer(3);
    socket.message(frame);
    expect(onFrame).toHaveBeenCalledWith(frame);
    expect(client.send({ type: "takeControl" })).toBe(false);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "reload" })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("revokes input immediately on release and exposes pending dialog state", () => {
    const { client, socket, onControl } = connect();
    const owned = {
      ...agent,
      controller: "you" as const,
      dialog: { type: "prompt", message: "Name?", defaultValue: "initial" },
    };
    socket.control(owned);
    expect(onControl).toHaveBeenLastCalledWith(owned);
    expect(client.send({ type: "dialog", accept: true, promptText: "answer" })).toBe(true);
    expect(client.send({ type: "releaseControl" })).toBe(true);
    socket.control({ ...agent, generation: 2 });
    expect(client.send({ type: "text", text: "late input" })).toBe(false);
    expect(client.send({ type: "dialog", accept: false })).toBe(false);
    client.stop();
  });
});

describe("preview stream downloads", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("offers a download at a URL carrying the stream's ticket", () => {
    const onDownload = vi.fn();
    createPreviewStreamClient(
      {
        ...target,
        access: { ...target.access, query: { wsTicket: "ticket" }, credentials: false },
      },
      {
        onFrame: vi.fn(),
        onDownload,
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "download", id: "d1", fileName: "a b.csv", sizeBytes: 3 }),
    );
    expect(onDownload).toHaveBeenCalledExactlyOnceWith({
      fileName: "a b.csv",
      sizeBytes: 3,
      url: "http://preview.test/api/preview-stream/download?threadId=thread&tabId=tab&id=d1&wsTicket=ticket",
    });
  });
});

describe("preview stream agent pointer", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("reports where the agent moves and clicks, ignoring malformed points", () => {
    const onPointer = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPointer,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "drag", x: 1, y: 2, sequence: 1 }),
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "click", x: 140, y: 50, sequence: 2 }),
    );
    expect(onPointer).toHaveBeenCalledExactlyOnceWith({
      phase: "click",
      x: 140,
      y: 50,
      sequence: 2,
    });
  });
});

describe("preview stream element picking", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("reports a picked element with its bounds and screenshot", () => {
    const onPickedElement = vi.fn();
    const onPickCancelled = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPickedElement,
      onPickCancelled,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    const payload = {
      pageUrl: "https://example.test/",
      pageTitle: "Example",
      tagName: "BUTTON",
      selector: "#go",
      htmlPreview: '<button id="go">Go</button>',
      componentName: null,
      source: null,
      stack: [],
      styles: "display: block",
      pickedAt: "2026-01-01T00:00:00.000Z",
    };
    FakeSocket.current.message(
      JSON.stringify({
        type: "pickedElement",
        payload,
        rect: { x: 1, y: 2, width: 30, height: 40 },
        screenshot: { dataUrl: "data:image/png;base64,AA==", width: 30, height: 40 },
      }),
    );
    expect(onPickedElement).toHaveBeenCalledExactlyOnceWith({
      payload,
      rect: { x: 1, y: 2, width: 30, height: 40 },
      screenshot: { dataUrl: "data:image/png;base64,AA==", width: 30, height: 40 },
    });
    FakeSocket.current.message(JSON.stringify({ type: "pickCancelled" }));
    expect(onPickCancelled).toHaveBeenCalledOnce();
  });

  it("ignores a picked element with malformed bounds", () => {
    const onPickedElement = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPickedElement,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.message(
      JSON.stringify({ type: "pickedElement", payload: {}, rect: { x: 1 } }),
    );
    expect(onPickedElement).not.toHaveBeenCalled();
  });
});

describe("preview stream action confirmation", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("reports the pending action and lets a denied confirmation reply without control", () => {
    const onConfirmation = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onConfirmation,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.message(
      JSON.stringify({
        type: "control",
        canOperate: true,
        controller: "agent",
        generation: 1,
        dialog: null,
      }),
    );
    FakeSocket.current.message(
      JSON.stringify({
        type: "confirmation",
        id: "confirm-1",
        origin: "https://example.test",
        action: "click",
        pageUrl: "https://example.test/account",
        text: null,
        element: { tagName: "BUTTON", text: "Delete", selector: "#delete" },
        rect: { x: 1, y: 2, width: 30, height: 40 },
      }),
    );
    expect(onConfirmation).toHaveBeenCalledExactlyOnceWith({
      id: "confirm-1",
      origin: "https://example.test",
      action: "click",
      pageUrl: "https://example.test/account",
      text: null,
      element: { tagName: "BUTTON", text: "Delete", selector: "#delete" },
      rect: { x: 1, y: 2, width: 30, height: 40 },
    });
    expect(
      client.send({
        type: "confirmationResponse",
        id: "confirm-1",
        approved: false,
        trust: false,
      }),
    ).toBe(true);
    expect(FakeSocket.current.sent.at(-1)).toBe(
      JSON.stringify({
        type: "confirmationResponse",
        id: "confirm-1",
        approved: false,
        trust: false,
      }),
    );
  });
  describe("preview stream browser install", () => {
    beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
    afterEach(() => vi.unstubAllGlobals());

    const connectWithSetup = () => {
      const onHostSetup = vi.fn();
      const client = createPreviewStreamClient(target, {
        onFrame: vi.fn(),
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
        onHostSetup,
      });
      return { client, socket: FakeSocket.current, onHostSetup };
    };

    const close = (socket: FakeSocket, code: number, reason: string) => {
      socket.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
    };

    it("reports download progress and keeps reconnecting while Chrome installs", () => {
      const { client, socket, onHostSetup } = connectWithSetup();
      close(
        socket,
        4503,
        JSON.stringify({
          need: "installing",
          downloadedBytes: 50_000_000,
          totalBytes: 126_922_702,
          unpacking: false,
        }),
      );
      expect(onHostSetup).toHaveBeenCalledWith({
        need: "installing",
        downloadedBytes: 50_000_000,
        totalBytes: 126_922_702,
        unpacking: false,
      });
      expect(previewStreamInstallPercent(onHostSetup.mock.calls[0]![0])).toBe(39);
      client.stop();
    });

    it("names a failed install and an unsupported platform", () => {
      const { client, socket, onHostSetup } = connectWithSetup();
      close(
        socket,
        4503,
        JSON.stringify({
          need: "install-failed",
          detail: "The download from storage.googleapis.com failed.",
        }),
      );
      expect(onHostSetup).toHaveBeenCalledWith({
        need: "install-failed",
        detail: "The download from storage.googleapis.com failed.",
      });
      expect(previewStreamHostSetupMessage(onHostSetup.mock.calls[0]![0])).toContain(
        "The download from storage.googleapis.com failed.",
      );
      client.stop();
    });

    it("describes each setup state", () => {
      expect(
        previewStreamHostSetupMessage({
          need: "installing",
          downloadedBytes: 0,
          totalBytes: 0,
          unpacking: true,
        }),
      ).toContain("unpacking");
      expect(
        previewStreamHostSetupMessage({ need: "unsupported", platform: "linux", arch: "riscv64" }),
      ).toContain("linux-riscv64");
    });
  });
});

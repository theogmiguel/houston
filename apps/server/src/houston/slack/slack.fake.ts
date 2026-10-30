// @effect-diagnostics nodeBuiltinImport:off - serves the loopback Slack fake.
// A Slack on 127.0.0.1: the Web API (form bodies), files under /files/ and Socket Mode at /link.
// Every call is recorded with its token; nothing reaches slack.com.
import * as NodeHttp from "node:http";

import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";

export const FAKE_TEAM = "T1";
export const FAKE_BOT = "UBOT";

export interface SlackFakeCall {
  readonly method: string;
  /** The bearer token, or null without one. */
  readonly token: string | null;
  readonly body: Readonly<Record<string, string>>;
}

export interface SlackFakeAnswer {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Never answers. */
  readonly stall?: boolean;
}

export interface SlackFakeFile {
  readonly status?: number;
  readonly body: Uint8Array;
}

export interface SlackFakeSocket {
  readonly id: number;
  /** Every frame the client sent, parsed as JSON. */
  readonly received: Array<unknown>;
  /** Pings the client sent. */
  pings: number;
  closed: boolean;
  readonly send: (value: unknown) => void;
  readonly close: (code?: number) => void;
}

export interface SlackFake {
  readonly origin: string;
  readonly calls: Array<SlackFakeCall>;
  /** Paths of every file download. */
  readonly fileRequests: Array<string>;
  readonly files: Map<string, SlackFakeFile>;
  /** Channel id -> messages, in any order; `conversations.history` serves them newest first. */
  readonly history: Map<string, Array<Record<string, unknown>>>;
  /** `<channel>:<thread ts>` -> replies, the parent excluded. */
  readonly replies: Map<string, Array<Record<string, unknown>>>;
  readonly sockets: Array<SlackFakeSocket>;
  /** For each new socket: whether it says hello, and whether it answers pings. */
  readonly socketMode: { hello: boolean; answerPings: boolean };
  /** A test's answer for a call, or null for the default. */
  override: (call: SlackFakeCall) => SlackFakeAnswer | null;
  /** Whether `chat.postMessage` and `chat.update` refuse any blocks with `invalid_blocks`. */
  refuseBlocks: boolean;
  /** The calls of `method`. */
  readonly callsOf: (method: string) => ReadonlyArray<SlackFakeCall>;
}

// Slack's documented Block Kit bounds the fake enforces, as Houston 1's wire tests did.
const invalidBlocks = (raw: string | undefined): boolean => {
  if (raw === undefined) return false;
  let blocks: unknown;
  try {
    blocks = JSON.parse(raw);
  } catch {
    return true;
  }
  if (!Array.isArray(blocks) || blocks.length > 50) return true;
  for (const block of blocks as Array<Record<string, unknown>>) {
    if (typeof block.type !== "string") return true;
    const text = block.text as { text?: unknown } | undefined;
    if (block.type === "section" && (typeof text?.text !== "string" || text.text.length > 3_000)) {
      return true;
    }
    if (block.type === "actions") {
      const elements = block.elements;
      if (!Array.isArray(elements) || elements.length === 0 || elements.length > 25) return true;
      for (const element of elements as Array<Record<string, unknown>>) {
        const label = (element.text as { text?: unknown } | undefined)?.text;
        if (typeof label !== "string" || label.length > 75) return true;
      }
    }
  }
  return false;
};

const tsOf = (message: Record<string, unknown>) => Number(message.ts ?? "0");

/** The fake for the scope's lifetime. */
export const makeSlackFake = Effect.acquireRelease(
  Effect.callback<{
    readonly fake: SlackFake;
    readonly server: NodeHttp.Server;
    readonly sockets: ReadonlyArray<InstanceType<typeof NodeWS.WebSocketServer>>;
  }>((resume) => {
    let posted = 0;
    let socketIds = 0;
    const calls: Array<SlackFakeCall> = [];
    const fake: SlackFake = {
      origin: "",
      calls,
      fileRequests: [],
      files: new Map(),
      history: new Map(),
      replies: new Map(),
      sockets: [],
      socketMode: { hello: true, answerPings: true },
      override: () => null,
      refuseBlocks: false,
      callsOf: (method) => calls.filter((call) => call.method === method),
    };

    const defaultAnswer = (call: SlackFakeCall): SlackFakeAnswer => {
      const body = call.body;
      switch (call.method) {
        case "auth.test":
          return {
            body: { ok: true, team_id: FAKE_TEAM, team: "Acme", user_id: FAKE_BOT, bot_id: "B1" },
          };
        case "apps.connections.open":
          return {
            body: {
              ok: true,
              url: `${fake.origin.replace("http:", "ws:")}/link?n=${socketIds + 1}`,
            },
          };
        case "chat.getPermalink":
          return {
            body: {
              ok: true,
              permalink: `https://acme.slack.com/archives/${body.channel}/p${String(body.message_ts).replace(".", "")}`,
            },
          };
        case "conversations.open":
          return { body: { ok: true, channel: { id: `D${body.users}` } } };
        case "chat.postMessage":
        case "chat.update": {
          if (body.blocks !== undefined && (fake.refuseBlocks || invalidBlocks(body.blocks))) {
            return { body: { ok: false, error: "invalid_blocks" } };
          }
          posted += 1;
          return {
            body: {
              ok: true,
              channel: body.channel,
              ts: body.ts ?? `1800000000.${String(posted).padStart(6, "0")}`,
            },
          };
        }
        case "conversations.history": {
          const oldest = Number(body.oldest ?? "0");
          const all = [...(fake.history.get(body.channel ?? "") ?? [])]
            .filter((message) => tsOf(message) > oldest)
            .sort((a, b) => tsOf(b) - tsOf(a));
          const limit = Number(body.limit ?? "100");
          const start = Number(body.cursor ?? "0");
          const page = all.slice(start, start + limit);
          const more = start + limit < all.length;
          return {
            body: {
              ok: true,
              messages: page,
              has_more: more,
              response_metadata: { next_cursor: more ? String(start + limit) : "" },
            },
          };
        }
        case "conversations.replies": {
          const oldest = Number(body.oldest ?? "0");
          const all = (fake.replies.get(`${body.channel}:${body.ts}`) ?? []).filter(
            (message) => tsOf(message) > oldest,
          );
          return { body: { ok: true, messages: all, has_more: false } };
        }
        default:
          return { body: { ok: true } };
      }
    };

    const server = NodeHttp.createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const path = request.url ?? "/";
        const authorization = request.headers.authorization;
        if (path.startsWith("/files/")) {
          fake.fileRequests.push(path);
          const file = fake.files.get(path);
          response.writeHead(file?.status ?? (file === undefined ? 404 : 200), {
            "content-type": "application/octet-stream",
          });
          response.end(file === undefined ? "" : Buffer.from(file.body));
          return;
        }
        const match = /^\/api\/([a-zA-Z.]+)$/.exec(path);
        const text = Buffer.concat(chunks).toString("utf8");
        const body: Record<string, string> = {};
        for (const [key, value] of new URLSearchParams(text)) body[key] = value;
        const call: SlackFakeCall = {
          method: match?.[1] ?? path,
          token: authorization?.startsWith("Bearer ") ? authorization.slice(7) : null,
          body,
        };
        calls.push(call);
        const answer = fake.override(call) ?? defaultAnswer(call);
        if (answer.stall === true) return;
        response.writeHead(answer.status ?? 200, {
          "content-type": "application/json",
          ...answer.headers,
        });
        response.end(JSON.stringify(answer.body ?? {}));
      });
    });

    const answering = new NodeWS.WebSocketServer({ noServer: true });
    const silent = new NodeWS.WebSocketServer({ noServer: true, autoPong: false });
    const onConnection = (socket: InstanceType<typeof NodeWS.WebSocket>) => {
      socketIds += 1;
      const entry: SlackFakeSocket = {
        id: socketIds,
        received: [],
        pings: 0,
        closed: false,
        send: (value) => socket.send(JSON.stringify(value)),
        close: (code = 1000) => socket.close(code),
      };
      socket.on("message", (data) => {
        try {
          entry.received.push(JSON.parse(String(data)));
        } catch {
          entry.received.push(String(data));
        }
      });
      socket.on("ping", () => {
        entry.pings += 1;
      });
      socket.on("close", () => {
        entry.closed = true;
      });
      fake.sockets.push(entry);
      if (fake.socketMode.hello) entry.send({ type: "hello", num_connections: 1 });
    };
    answering.on("connection", onConnection);
    silent.on("connection", onConnection);
    server.on("upgrade", (request, socket, head) => {
      const target = fake.socketMode.answerPings ? answering : silent;
      target.handleUpgrade(request, socket, head, (ws) => target.emit("connection", ws, request));
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      (fake as { origin: string }).origin =
        typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "";
      resume(Effect.succeed({ fake, server, sockets: [answering, silent] }));
    });
  }),
  ({ server, sockets }) =>
    Effect.callback<void>((resume) => {
      for (const wss of sockets) {
        for (const client of wss.clients) client.terminate();
        wss.close();
      }
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    }),
).pipe(Effect.map(({ fake }) => fake));

/** An `app_mention` event envelope as Socket Mode sends it. */
export const mentionEnvelope = (
  envelopeId: string,
  event: Record<string, unknown>,
): Record<string, unknown> => ({
  envelope_id: envelopeId,
  type: "events_api",
  accepts_response_payload: false,
  payload: { team_id: FAKE_TEAM, type: "event_callback", event },
});

export const mentionEvent = (
  ts: string,
  text: string,
  patch: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "app_mention",
  channel: "C1",
  user: "U2",
  team: FAKE_TEAM,
  ts,
  text: `<@${FAKE_BOT}> ${text}`,
  ...patch,
});

/** An interactive envelope (a button click or a dialog submission). */
export const interactiveEnvelope = (
  envelopeId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> => ({
  envelope_id: envelopeId,
  type: "interactive",
  accepts_response_payload: false,
  payload,
});

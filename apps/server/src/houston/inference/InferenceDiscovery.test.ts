import { describe, expect, it } from "@effect/vitest";
import { InferenceServerId } from "@houston-app/contracts/houston/inference";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import * as ServerSettings from "../../serverSettings.ts";
import * as InferenceDiscovery from "./InferenceDiscovery.ts";

const rtx = InferenceServerId.make("rtx");
const spark1 = InferenceServerId.make("spark1");

// Listeners on 8030 (any address), 22 (below 1024), and 5432 (loopback).
const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1F5E 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5001 1 0000000000000000 100 0 0 10 0
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5002 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5003 1 0000000000000000 100 0 0 10 0
`;

const glm = {
  object: "list",
  data: [{ id: "GLM-5.3-Flash", owned_by: "tensorfold", context_length: 702464 }],
};

function discover(
  input: Parameters<InferenceDiscovery.InferenceDiscovery["Service"]["discover"]>[0],
  routes: Readonly<Record<string, unknown>>,
  inferenceServers: Record<string, { baseUrl: string; enabled: boolean }>,
) {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        seen.push({ url: request.url, auth: request.headers["authorization"] });
        const route = routes[request.url];
        if (route === undefined) {
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new TypeError("fetch failed"),
              }),
            }),
          );
        }
        const response =
          typeof route === "number"
            ? new Response("", { status: route })
            : Response.json(route, { status: 200 });
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      }),
    ),
  );
  const missing = FileSystem.makeNoop({});
  return Effect.gen(function* () {
    const discovery = yield* InferenceDiscovery.make;
    const result = yield* discovery.discover(input);
    return { result, seen };
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({ inferenceServers }),
      FileSystem.layerNoop({
        readFileString: (path) =>
          path === "/proc/net/tcp" ? Effect.succeed(PROC_NET_TCP) : missing.readFileString(path),
      }),
      http,
    ]),
  );
}

describe("InferenceDiscovery", () => {
  it.effect("finds a server that moved to an unlisted port, without sending a key", () =>
    Effect.gen(function* () {
      const { result, seen } = yield* discover(
        {},
        {
          "http://localhost:8030/v1/models": glm,
          "http://localhost:8030/v1/chat/completions": 400,
          "http://localhost:8030/v1/responses": 404,
        },
        { [rtx]: { baseUrl: "http://localhost:8888/v1", enabled: true } },
      );
      expect(result).toEqual({
        servers: [
          {
            baseUrl: "http://localhost:8030/v1",
            status: "ready",
            engine: "TensorFold",
            models: [{ id: "GLM-5.3-Flash", servedContextWindow: 702464 }],
            apiProtocols: ["chat-completions"],
          },
        ],
        searchedListeningPorts: true,
      });
      expect(seen.some((request) => request.url.includes(":22/"))).toBe(false);
      expect(seen.some((request) => request.url === "http://localhost:5432/v1/models")).toBe(true);
      expect(seen.every((request) => request.auth === undefined)).toBe(true);
    }),
  );

  it.effect("reports a server that wants a key, and marks one already registered", () =>
    Effect.gen(function* () {
      const { result } = yield* discover(
        {},
        {
          "http://localhost:11434/v1/models": 401,
          "http://127.0.0.1:1234/v1/models": glm,
        },
        { [rtx]: { baseUrl: "http://127.0.0.1:1234/v1", enabled: true } },
      );
      expect(
        result.servers.map(({ baseUrl, status, registeredServerId }) => ({
          baseUrl,
          status,
          registeredServerId,
        })),
      ).toEqual([
        { baseUrl: "http://127.0.0.1:1234/v1", status: "ready", registeredServerId: rtx },
        {
          baseUrl: "http://localhost:11434/v1",
          status: "needs-key",
          registeredServerId: undefined,
        },
      ]);
    }),
  );
});

describe("discoveryCandidates", () => {
  const registered = [
    [rtx, "http://rtx:8888/v1"],
    [spark1, "http://spark1:8888/v1"],
  ] as const;

  it("searches a remote host by its saved and well-known ports only", () => {
    expect(
      InferenceDiscovery.discoveryCandidates({
        host: "spark1",
        registered,
        listeningPorts: [8030],
        hostname: "rtx",
      }).map((candidate) => candidate.base),
    ).toEqual([
      "http://spark1:8888/v1",
      ...InferenceDiscovery.WELL_KNOWN_PORTS.map((port) => `http://spark1:${port}/v1`),
    ]);
  });

  it("treats every name of this machine as one, keeping the name a repair used", () => {
    const bases = InferenceDiscovery.discoveryCandidates({
      host: "rtx",
      registered,
      listeningPorts: [8030],
      hostname: "rtx",
    });
    expect(bases).toContainEqual({ base: "http://rtx:8888/v1", registeredServerId: rtx });
    expect(bases).toContainEqual({ base: "http://rtx:8030/v1" });
    expect(bases.some((candidate) => candidate.base.includes("spark1"))).toBe(false);
  });
});

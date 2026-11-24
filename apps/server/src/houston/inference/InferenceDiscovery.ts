import * as NodeOS from "node:os";

import type {
  InferenceApiProtocol,
  InferenceDiscoveredServer,
  InferenceDiscoveryInput,
  InferenceDiscoveryResult,
  InferenceServerId,
} from "@houston-app/contracts/houston/inference";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import { parseProcNetTcp } from "../../preview/PortScanner.ts";
import * as Settings from "../../serverSettings.ts";
import { PROTOCOL_PATHS, parseBaseUrl, readModelList } from "./InferenceServerRegistry.ts";

export class InferenceDiscovery extends Context.Service<
  InferenceDiscovery,
  {
    /** Model servers answering on this machine or a registered host. Probes never carry a saved key. */
    readonly discover: (input: InferenceDiscoveryInput) => Effect.Effect<InferenceDiscoveryResult>;
  }
>()("@houston-app/cli/houston/inference/InferenceDiscovery") {}

// Ollama, LM Studio, llama.cpp, vLLM, SGLang.
export const WELL_KNOWN_PORTS: ReadonlyArray<number> = [11434, 1234, 8080, 8000, 30000];
const PROBE_TIMEOUT = Duration.millis(1500);
const SEARCH_DEADLINE = Duration.seconds(8);
const MAX_LISTENERS = 48;
const MAX_CANDIDATES = 80;
const MAX_BODY_BYTES = 4_000_000;
const AGENT_PROTOCOLS: ReadonlyArray<InferenceApiProtocol> = ["chat-completions", "responses"];
const PROC_TABLES = ["/proc/net/tcp", "/proc/net/tcp6"];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const TRAILING_SLASHES = /\/+$/;

/** Whether `host` names the machine this server runs on. */
function isThisMachine(host: string, hostname: string = NodeOS.hostname()): boolean {
  const lower = host.toLowerCase();
  const own = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(lower) || lower === own || lower === own.split(".")[0];
}

/** One key per endpoint, whichever name of this machine an address uses. */
function endpointKey(base: string, hostname: string): string | undefined {
  try {
    const url = new URL(base);
    const host = isThisMachine(url.hostname, hostname) ? "localhost" : url.hostname.toLowerCase();
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${url.protocol}//${host}:${port}${url.pathname.replace(TRAILING_SLASHES, "")}`;
  } catch {
    return undefined;
  }
}

interface Candidate {
  readonly base: string;
  readonly registeredServerId?: InferenceServerId;
}

/**
 * Where to look: an address the user typed, registered servers, well-known ports and (on Linux)
 * every listening port of this machine, and well-known ports of registered hosts. `host` narrows
 * the search to one machine.
 */
export function discoveryCandidates(input: {
  readonly host?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly registered: ReadonlyArray<readonly [InferenceServerId, string]>;
  readonly listeningPorts: ReadonlyArray<number>;
  readonly hostname: string;
}): ReadonlyArray<Candidate> {
  const candidates = new Map<string, Candidate>();
  const add = (base: string, registeredServerId?: InferenceServerId) => {
    const key = endpointKey(base, input.hostname);
    if (key === undefined) return;
    const existing = candidates.get(key);
    if (existing !== undefined) {
      if (registeredServerId !== undefined && existing.registeredServerId === undefined) {
        candidates.set(key, { ...existing, registeredServerId });
      }
      return;
    }
    if (candidates.size >= MAX_CANDIDATES) return;
    candidates.set(key, {
      base,
      ...(registeredServerId === undefined ? {} : { registeredServerId }),
    });
  };
  const target = input.host?.toLowerCase();
  const sameHost = (host: string) =>
    target === undefined ||
    host.toLowerCase() === target ||
    (isThisMachine(host, input.hostname) && isThisMachine(target, input.hostname));
  const searchesThisMachine = target === undefined || isThisMachine(target, input.hostname);
  // The server reaches its own machine by loopback, unless a repair names it another way.
  const localHost =
    target !== undefined && !LOOPBACK_HOSTS.has(target) && searchesThisMachine
      ? target
      : "localhost";

  if (input.baseUrl !== undefined) {
    const typed = parseBaseUrl(input.baseUrl);
    if ("base" in typed) add(typed.base);
  }
  const remoteHosts = new Set<string>();
  for (const [id, baseUrl] of input.registered) {
    const endpoint = parseBaseUrl(baseUrl);
    if (!("base" in endpoint)) continue;
    const { hostname } = new URL(endpoint.base);
    if (!sameHost(hostname)) continue;
    add(endpoint.base, id);
    if (!isThisMachine(hostname, input.hostname)) remoteHosts.add(hostname);
  }
  if (target !== undefined && !searchesThisMachine) remoteHosts.add(target);
  if (searchesThisMachine) {
    for (const port of [...WELL_KNOWN_PORTS, ...input.listeningPorts]) {
      add(`http://${localHost}:${port}/v1`);
    }
  }
  for (const host of remoteHosts) {
    for (const port of WELL_KNOWN_PORTS) add(`http://${host}:${port}/v1`);
  }
  return [...candidates.values()];
}

// Ports this high are usually handed out by the OS to helpers, not chosen for a model server.
const EPHEMERAL_PORT_FLOOR = 32768;

const portOf = (baseUrl: string) => {
  try {
    return Number(new URL(baseUrl).port) || 0;
  } catch {
    return 0;
  }
};

/** Ready before needing a key, then servers on chosen ports, then ones not yet registered. */
const rank = (server: InferenceDiscoveredServer) =>
  (server.status === "ready" ? 0 : 4) +
  (portOf(server.baseUrl) >= EPHEMERAL_PORT_FLOOR ? 2 : 0) +
  (server.registeredServerId === undefined ? 0 : 1);

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const settingsService = yield* Settings.ServerSettingsService;

  const listeningPorts = Effect.forEach(PROC_TABLES, (path) =>
    fileSystem.readFileString(path).pipe(Effect.option),
  ).pipe(
    Effect.map((tables) => {
      const read = tables.flatMap((table) => (Option.isSome(table) ? [table.value] : []));
      const ports = new Set(read.flatMap((table) => parseProcNetTcp(table).map((l) => l.port)));
      // Chosen ports first, so a busy machine's OS-assigned ones cannot crowd them out of the cap.
      const rankPort = (port: number) => (port >= EPHEMERAL_PORT_FLOOR ? port + 65536 : port);
      return {
        searched: read.length > 0,
        ports: [...ports]
          .filter((port) => port >= 1024)
          .toSorted((left, right) => rankPort(left) - rankPort(right))
          .slice(0, MAX_LISTENERS),
      };
    }),
  );

  // Untraced: one per candidate port; the discover span covers them. Reading stops at the cap,
  // so an unrelated service answering with a large body cannot fill memory.
  const get = Effect.fnUntraced(function* (url: string) {
    return yield* client.execute(HttpClientRequest.get(url)).pipe(
      Effect.flatMap((response) => {
        let read = 0;
        return response.stream.pipe(
          Stream.takeWhile((chunk) => {
            read += chunk.length;
            return read <= MAX_BODY_BYTES;
          }),
          Stream.decodeText(),
          Stream.mkString,
          Effect.map((body) => ({
            status: response.status,
            body: read > MAX_BODY_BYTES ? undefined : body,
          })),
        );
      }),
      Effect.timeoutOption(PROBE_TIMEOUT),
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
  });

  // An empty POST costs no generation: a served route rejects it as invalid.
  const served = Effect.fnUntraced(function* (url: string) {
    return yield* client
      .execute(
        HttpClientRequest.post(url).pipe(HttpClientRequest.bodyText("{}", "application/json")),
      )
      .pipe(
        Effect.map(
          (response) =>
            response.status === 400 ||
            response.status === 422 ||
            (response.status >= 200 && response.status < 300),
        ),
        Effect.timeoutOption(PROBE_TIMEOUT),
        Effect.map((result) => Option.getOrElse(result, () => false)),
        Effect.orElseSucceed(() => false),
      );
  });

  const probe = Effect.fnUntraced(function* (candidate: Candidate) {
    const listed = yield* get(`${candidate.base}/models`);
    if (listed === undefined) return undefined;
    const common = {
      baseUrl: candidate.base,
      ...(candidate.registeredServerId === undefined
        ? {}
        : { registeredServerId: candidate.registeredServerId }),
    };
    if (listed.status === 401 || listed.status === 403) {
      return { ...common, status: "needs-key", models: [] } satisfies InferenceDiscoveredServer;
    }
    if (listed.status < 200 || listed.status >= 300 || listed.body === undefined) return undefined;
    const list = readModelList(listed.body);
    if (list === undefined || list.models.length === 0) return undefined;
    const protocols = yield* Effect.forEach(
      PROTOCOL_PATHS.filter(([protocol]) => AGENT_PROTOCOLS.includes(protocol)),
      ([protocol, path]) =>
        served(`${candidate.base}/${path}`).pipe(Effect.map((ok) => (ok ? [protocol] : []))),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((found) => found.flat()));
    return {
      ...common,
      status: "ready",
      models: list.models,
      ...(list.engine === undefined ? {} : { engine: list.engine }),
      ...(protocols.length === 0 ? {} : { apiProtocols: protocols }),
    } satisfies InferenceDiscoveredServer;
  });

  const discover = Effect.fn("InferenceDiscovery.discover")(function* (
    input: InferenceDiscoveryInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.option);
    const registered = Option.isSome(settings)
      ? Object.entries(settings.value.inferenceServers).map(
          ([id, config]) => [id as InferenceServerId, config.baseUrl] as const,
        )
      : [];
    const hostname = NodeOS.hostname();
    const searchesThisMachine = input.host === undefined || isThisMachine(input.host, hostname);
    const listeners = searchesThisMachine
      ? yield* listeningPorts
      : { searched: false, ports: [] as ReadonlyArray<number> };
    const candidates = discoveryCandidates({
      host: input.host,
      baseUrl: input.baseUrl,
      registered,
      listeningPorts: listeners.ports,
      hostname,
    });
    const found = yield* Ref.make<ReadonlyArray<InferenceDiscoveredServer>>([]);
    // A slow host cannot hold the answer back; whatever answered by the deadline is shown.
    yield* Effect.forEach(
      candidates,
      (candidate) =>
        probe(candidate).pipe(
          Effect.flatMap((server) =>
            server === undefined ? Effect.void : Ref.update(found, (all) => [...all, server]),
          ),
        ),
      { concurrency: 16, discard: true },
    ).pipe(Effect.timeoutOption(SEARCH_DEADLINE));
    const servers = (yield* Ref.get(found)).toSorted(
      (left, right) => rank(left) - rank(right) || left.baseUrl.localeCompare(right.baseUrl),
    );
    return { servers, searchedListeningPorts: listeners.searched };
  });

  return InferenceDiscovery.of({ discover });
});

export const layer = Layer.effect(InferenceDiscovery, make);

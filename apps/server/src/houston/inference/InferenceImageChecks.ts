import * as NodeZlib from "node:zlib";

import type {
  InferenceImageCheckInput,
  InferenceImageCheckResult,
  InferenceServerId,
} from "@houston-app/contracts/houston/inference";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as Settings from "../../serverSettings.ts";
import * as HoustonSecrets from "../secrets/HoustonSecrets.ts";
import * as InferenceAdmission from "./InferenceAdmission.ts";
import * as InferenceImageVerdicts from "./InferenceImageVerdicts.ts";
import * as InferenceServerRegistry from "./InferenceServerRegistry.ts";

const PALETTE = {
  red: [230, 30, 30],
  green: [30, 170, 60],
  blue: [30, 70, 220],
  yellow: [240, 220, 30],
  black: [0, 0, 0],
  white: [255, 255, 255],
  orange: [245, 140, 20],
  purple: [130, 40, 170],
} as const;
export type Colour = keyof typeof PALETTE;
export const COLOURS = Object.keys(PALETTE) as ReadonlyArray<Colour>;
const COLOUR_WORD = new RegExp(`\\b(${COLOURS.join("|")})\\b`, "gi");
const WHITESPACE = /\s+/g;

// Four distinct colours out of eight: a model guessing blind passes once in 1680 checks.
const CHALLENGES = 4;
const ANSWER_TOKENS = 64;
const CHECK_TIMEOUT = Duration.seconds(120);
// Above the smallest input common vision encoders accept.
const IMAGE_SIZE = 128;
const PROMPT = `What single colour fills this image? Reply with one word: ${COLOURS.join(", ")}.`;

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(NodeZlib.crc32(typed) >>> 0);
  return Buffer.concat([length, typed, checksum]);
}

/** A square RGB PNG filled with one colour. */
function solidColourPng(rgb: readonly [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(IMAGE_SIZE, 0);
  header.writeUInt32BE(IMAGE_SIZE, 4);
  header[8] = 8;
  header[9] = 2;
  // Each scanline starts with filter type 0.
  const row = Buffer.alloc(1 + IMAGE_SIZE * 3);
  for (let x = 0; x < IMAGE_SIZE; x++) row.set(rgb, 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: IMAGE_SIZE }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", NodeZlib.deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export const challengeImageUrl = (colour: Colour) =>
  `data:image/png;base64,${solidColourPng(PALETTE[colour]).toString("base64")}`;

const lastColour = (text: string): Colour | undefined =>
  (text.match(COLOUR_WORD)?.at(-1)?.toLowerCase() as Colour | undefined) ?? undefined;

/** The colour a reply settles on: the last palette word of its answer, else of its reasoning. */
function readColourAnswer(answer: string, reasoning: string): Colour | undefined {
  return lastColour(answer) ?? lastColour(reasoning);
}

const ChatReply = Schema.Struct({
  choices: Schema.NonEmptyArray(
    Schema.Struct({
      message: Schema.Struct({
        content: Schema.optional(
          Schema.NullOr(
            Schema.Union([
              Schema.String,
              Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
            ]),
          ),
        ),
        reasoning_content: Schema.optional(Schema.NullOr(Schema.String)),
        reasoning: Schema.optional(Schema.NullOr(Schema.String)),
      }),
      finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
const decodeChatReply = Schema.decodeUnknownOption(Schema.fromJsonString(ChatReply));

type Reply =
  | {
      readonly _tag: "Answered";
      readonly answer: string;
      readonly reasoning: string;
      readonly truncated: boolean;
    }
  | { readonly _tag: "Refused"; readonly status: number; readonly body: string }
  | { readonly _tag: "Failed" };

/** Reads a non-streamed chat completion; anything else counts as a failure to answer. */
function readChatReply(status: number, body: string): Reply {
  if (status < 200 || status >= 300) return { _tag: "Refused", status, body };
  const reply = decodeChatReply(body);
  if (reply._tag === "None") return { _tag: "Failed" };
  const [choice] = reply.value.choices;
  const content = choice.message.content;
  return {
    _tag: "Answered",
    answer:
      typeof content === "string"
        ? content
        : (content ?? []).map((part) => part.text ?? "").join(""),
    reasoning: choice.message.reasoning_content ?? choice.message.reasoning ?? "",
    truncated: choice.finish_reason === "length",
  };
}

// Busy or overloaded, not an answer about images.
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 502, 503, 504]);

const quote = (text: string) => {
  const flat = text.replace(WHITESPACE, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
};

/** Checks whether a model on a registered server reads images, by asking it to name colours. */
export class InferenceImageChecks extends Context.Service<
  InferenceImageChecks,
  {
    readonly check: (input: InferenceImageCheckInput) => Effect.Effect<InferenceImageCheckResult>;
  }
>()("@houston-app/cli/houston/inference/InferenceImageChecks") {}

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* HoustonSecrets.HoustonSecrets;
  const registry = yield* InferenceServerRegistry.InferenceServerRegistry;
  const admission = yield* InferenceAdmission.InferenceAdmission;
  const verdicts = yield* InferenceImageVerdicts.InferenceImageVerdicts;

  const unknown = (detail: string) => ({ outcome: "unknown", detail }) as const;

  const readApiKey = Effect.fnUntraced(function* (serverId: InferenceServerId) {
    const read = yield* secrets
      .get(InferenceServerRegistry.inferenceApiKeySecretName(serverId))
      .pipe(Effect.option);
    if (read._tag === "None") return undefined;
    return Option.match(read.value, {
      onNone: () => "",
      onSome: (value) => Redacted.value(value).trim(),
    });
  });

  const check = Effect.fn("InferenceImageChecks.check")(function* ({
    serverId,
    model,
  }: InferenceImageCheckInput) {
    const settings = yield* settingsService.getSettings.pipe(Effect.option);
    const config = settings._tag === "Some" ? settings.value.inferenceServers[serverId] : undefined;
    if (config === undefined) return unknown("This model server is no longer registered.");
    const snapshot = (yield* registry.current).find((candidate) => candidate.id === serverId);
    const name = snapshot?.displayName ?? serverId;
    if (!config.enabled) return unknown(`${name} is turned off.`);
    if (snapshot?.status !== "ready") return unknown(`${name} is not ready.`);
    if (!snapshot.models.some((served) => served.id === model)) {
      return unknown(`${name} does not serve ${model} any more.`);
    }
    if (snapshot.apiProtocols?.includes("chat-completions") !== true) {
      return unknown(`${name} does not serve the Chat Completions API the check uses.`);
    }
    const endpoint = InferenceServerRegistry.parseBaseUrl(config.baseUrl);
    if ("error" in endpoint) return unknown(endpoint.error);
    const apiKey = yield* readApiKey(serverId);
    if (apiKey === undefined) {
      return unknown("Could not read the API key from the secret store.");
    }

    const ask = (colour: Colour | undefined) =>
      client
        .execute(
          HttpClientRequest.post(`${endpoint.base}/chat/completions`).pipe(
            HttpClientRequest.bodyText(
              JSON.stringify({
                model,
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: PROMPT },
                      ...(colour === undefined
                        ? []
                        : [{ type: "image_url", image_url: { url: challengeImageUrl(colour) } }]),
                    ],
                  },
                ],
                max_tokens: ANSWER_TOKENS,
                temperature: 0,
                stream: false,
                // Thinking would spend the short answer; engines without the field ignore it.
                chat_template_kwargs: { enable_thinking: false },
              }),
              "application/json",
            ),
            apiKey === "" ? (request) => request : HttpClientRequest.bearerToken(apiKey),
          ),
        )
        .pipe(
          Effect.flatMap((response) =>
            Effect.map(response.text, (body) => readChatReply(response.status, body)),
          ),
          Effect.orElseSucceed((): Reply => ({ _tag: "Failed" })),
        );

    const verdict = (supported: boolean, detail: string) =>
      ({ outcome: supported ? "supported" : "unsupported", detail }) as const;

    const colours = (yield* Random.shuffle(COLOURS)).slice(0, CHALLENGES);
    const challenge = Effect.gen(function* () {
      yield* admission.admit({ serverId, purpose: "background" });
      for (const colour of colours) {
        const reply = yield* ask(colour);
        if (reply._tag === "Failed") return unknown(`${name} did not answer the check.`);
        if (reply._tag === "Refused" && TRANSIENT_STATUSES.has(reply.status)) {
          return unknown(`${name} is busy (${reply.status}). Try again.`);
        }
        if (reply._tag === "Refused") {
          // Only a server that answers the same question without the image refused the image.
          const control = yield* ask(undefined);
          return control._tag === "Answered"
            ? verdict(false, `${name} refuses images for ${model} but answers text.`)
            : unknown(`${name} answered ${reply.status}: ${quote(reply.body)}`);
        }
        // Reasoning cut off mid-thought may name any colour; only a finished one is graded.
        if (reply.truncated && readColourAnswer(reply.answer, "") === undefined) {
          return unknown(`${model} spent its whole answer reasoning. Try again.`);
        }
        const seen = readColourAnswer(reply.answer, reply.reasoning);
        if (seen === colour) continue;
        return verdict(
          false,
          `Shown a ${colour} image, ${model} answered "${quote(reply.answer || reply.reasoning)}".`,
        );
      }
      return verdict(true, `${model} named the colour of ${CHALLENGES} test images.`);
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(CHECK_TIMEOUT),
      Effect.map((result) =>
        result._tag === "Some"
          ? result.value
          : unknown(`${name} did not finish the check within 2 minutes.`),
      ),
      Effect.catchTags({
        InferenceAdmissionError: (error) => Effect.succeed(unknown(error.message)),
      }),
    );
    const result = yield* challenge;
    if (result.outcome !== "unknown") {
      yield* verdicts.record(endpoint.display, model, result.outcome === "supported");
      yield* registry.refresh(serverId);
    }
    return result;
  });

  return InferenceImageChecks.of({ check });
});

export const layer = Layer.effect(InferenceImageChecks, make);

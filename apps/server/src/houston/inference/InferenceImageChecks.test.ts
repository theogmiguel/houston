import { describe, expect, it } from "@effect/vitest";
import {
  InferenceServerId,
  type InferenceServerSnapshot,
} from "@houston-app/contracts/houston/inference";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSettings from "../../serverSettings.ts";
import * as HoustonSecrets from "../secrets/HoustonSecrets.ts";
import * as InferenceAdmission from "./InferenceAdmission.ts";
import * as InferenceImageChecks from "./InferenceImageChecks.ts";
import * as InferenceImageVerdicts from "./InferenceImageVerdicts.ts";
import * as InferenceServerRegistry from "./InferenceServerRegistry.ts";

const rtx = InferenceServerId.make("rtx");
const BASE = "http://rtx.test:8888/v1";
const MODEL = "glm";
const colourOfImage = new Map(
  InferenceImageChecks.COLOURS.map((colour) => [
    InferenceImageChecks.challengeImageUrl(colour),
    colour,
  ]),
);

type Reply = { readonly status: number; readonly body: unknown };
const answer = (content: string, extra: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: { choices: [{ message: { content, ...extra }, finish_reason: "stop" }] },
});

const snapshot: InferenceServerSnapshot = {
  id: rtx,
  displayName: "rtx",
  baseUrl: BASE,
  enabled: true,
  status: "ready",
  checkedAt: null,
  models: [{ id: MODEL }],
  apiProtocols: ["chat-completions"],
};

/** Runs one check against a server that answers each request with `serve(colour shown)`. */
const runCheck = (serve: (colour: string | undefined) => Reply) =>
  Effect.gen(function* () {
    const checks = yield* InferenceImageChecks.InferenceImageChecks;
    const verdicts = yield* InferenceImageVerdicts.InferenceImageVerdicts;
    const result = yield* checks.check({ serverId: rtx, model: MODEL });
    const recorded = (yield* verdicts.forAddress(BASE))(MODEL);
    return { result, recorded };
  }).pipe(
    Effect.provide(
      Layer.effect(InferenceImageChecks.InferenceImageChecks, InferenceImageChecks.make).pipe(
        Layer.provideMerge(InferenceImageVerdicts.layerMemory()),
        Layer.provide([
          ServerSettings.layerTest({
            inferenceServers: { [rtx]: { baseUrl: BASE, enabled: true } },
          }),
          Layer.mock(InferenceServerRegistry.InferenceServerRegistry)({
            current: Effect.succeed([snapshot]),
            refresh: () => Effect.succeed([snapshot]),
          }),
          Layer.mock(InferenceAdmission.InferenceAdmission)({ admit: () => Effect.void }),
          HoustonSecrets.layerMemory(),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                const sent =
                  request.body._tag === "Uint8Array"
                    ? JSON.parse(new TextDecoder().decode(request.body.body))
                    : {};
                const image = sent.messages?.[0]?.content?.find(
                  (part: { type: string }) => part.type === "image_url",
                )?.image_url?.url;
                const reply = serve(image === undefined ? undefined : colourOfImage.get(image));
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json(reply.body, { status: reply.status }),
                );
              }),
            ),
          ),
        ]),
      ),
    ),
  );

describe("InferenceImageChecks", () => {
  it.effect("trusts a model that names every colour, and remembers it", () =>
    Effect.gen(function* () {
      // One answer in content, one only in reasoning, both settle on the last colour named.
      let asked = 0;
      const { result, recorded } = yield* runCheck((colour) =>
        asked++ % 2 === 0
          ? answer(`Not white, it is ${colour}`)
          : answer("", { reasoning_content: `Looks ${colour}.` }),
      );
      expect(result.outcome).toBe("supported");
      expect(recorded).toMatchObject({ supported: true, source: "checked" });
      expect(recorded?.checkedAt).toBeTypeOf("string");
    }),
  );

  it.effect("calls a model text-only when it guesses or its server refuses only images", () =>
    Effect.gen(function* () {
      const guessing = yield* runCheck(() => answer("white"));
      expect(guessing.result.outcome).toBe("unsupported");
      expect(guessing.recorded?.supported).toBe(false);
      const refusing = yield* runCheck((colour) =>
        colour === undefined ? answer("blue") : { status: 400, body: { error: "no images" } },
      );
      expect(refusing.result.outcome).toBe("unsupported");
    }),
  );

  it.effect("records nothing when the check cannot tell", () =>
    Effect.gen(function* () {
      const broken = yield* runCheck(() => ({ status: 500, body: { error: "boom" } }));
      expect(broken.result.outcome).toBe("unknown");
      expect(broken.recorded).toBeUndefined();
      const thinking = yield* runCheck(() => ({
        status: 200,
        body: {
          choices: [
            { message: { content: "", reasoning_content: "Hmm, let me" }, finish_reason: "length" },
          ],
        },
      }));
      expect(thinking.result.outcome).toBe("unknown");
      expect(thinking.recorded).toBeUndefined();
      // A busy server is not refusing images, even when it then answers text.
      const busy = yield* runCheck((colour) =>
        colour === undefined ? answer("blue") : { status: 503, body: { error: "busy" } },
      );
      expect(busy.result.outcome).toBe("unknown");
      // Reasoning cut off mid-thought names colours it was only weighing.
      const cutOff = yield* runCheck(() => ({
        status: 200,
        body: {
          choices: [
            {
              message: { content: "", reasoning_content: "Is it red, or maybe purple" },
              finish_reason: "length",
            },
          ],
        },
      }));
      expect(cutOff.result.outcome).toBe("unknown");
      expect(cutOff.recorded).toBeUndefined();
    }),
  );
});

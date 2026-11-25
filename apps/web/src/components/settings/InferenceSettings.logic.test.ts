import {
  type InferenceServerId,
  InferenceServerId as InferenceServerIdSchema,
} from "@houston-app/contracts/houston/inference";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_INFERENCE_SERVER_DRAFT,
  inferenceServerFromDraft,
  inferenceServerIdFromName,
  inferenceServerOffers,
  inferenceServerOriginHost,
  normalizeInferenceServerBaseUrl,
} from "./InferenceSettings.logic";

describe("normalizeInferenceServerBaseUrl", () => {
  it.each([
    ["http://localhost:11434", "http://localhost:11434/v1"],
    [" http://localhost:11434/ ", "http://localhost:11434/v1"],
    ["https://spark1:8888/v1/", "https://spark1:8888/v1"],
    ["http://10.0.0.2:8000/openai/v1", "http://10.0.0.2:8000/openai/v1"],
  ])("accepts %s", (raw, expected) => {
    expect(normalizeInferenceServerBaseUrl(raw)).toEqual(Result.succeed(expected));
  });

  it.each([
    ["", "Enter the server URL."],
    ["localhost:11434", "Use an http:// or https:// URL."],
    ["not a url", "Enter a full URL, such as http://localhost:11434/v1."],
    ["ftp://host/v1", "Use an http:// or https:// URL."],
    ["http://user:pass@host/v1", "Remove the credentials from the URL and put the key in API key."],
    ["http://host/v1?api_key=abc", "Remove the query string; put any key in API key."],
    ["http://host/v1?", "Remove the query string; put any key in API key."],
    ["http://host/v1#x", "Remove the #fragment from the URL."],
  ])("rejects %j", (raw, message) => {
    expect(normalizeInferenceServerBaseUrl(raw)).toEqual(Result.fail(message));
  });
});

describe("inferenceServerIdFromName", () => {
  it.each([
    ["RTX 5090", "rtx-5090"],
    ["  Spark #1 ", "spark-1"],
    ["4090 box", "server-4090-box"],
    ["!!!", null],
  ])("%j -> %j", (name, id) => {
    expect(inferenceServerIdFromName(name)).toBe(id);
  });
});

describe("inferenceServerFromDraft", () => {
  const draft = { ...EMPTY_INFERENCE_SERVER_DRAFT, baseUrl: "http://spark1:8888" };

  it("slugs the name, falls back to the host, and refuses an existing id on add", () => {
    expect(inferenceServerFromDraft({ ...draft, name: "RTX" }, new Set(), { mode: "add" })).toEqual(
      Result.succeed({
        id: "rtx",
        displayName: "RTX",
        baseUrl: "http://spark1:8888/v1",
        enabled: true,
      }),
    );
    const byHost = inferenceServerFromDraft(draft, new Set(), { mode: "add" });
    expect(Result.isSuccess(byHost) && byHost.success.id).toBe("spark1");
    expect(inferenceServerFromDraft(draft, new Set(["spark1"]), { mode: "add" })).toEqual(
      Result.fail({ name: "A server with this name exists." }),
    );
  });

  it("keeps the id on edit and validates max concurrent requests", () => {
    const target = {
      mode: "edit",
      id: InferenceServerIdSchema.make("rtx"),
      enabled: true,
    } as const;
    const edited = inferenceServerFromDraft(
      { ...draft, name: "Renamed", maxConcurrentRequests: "4", apiKey: " key " },
      new Set(["rtx"]),
      target,
    );
    expect(edited).toEqual(
      Result.succeed({
        id: "rtx",
        displayName: "Renamed",
        baseUrl: "http://spark1:8888/v1",
        apiKey: "key",
        enabled: true,
        maxConcurrentRequests: 4,
      }),
    );
    for (const maxConcurrentRequests of ["0", "1.5", "two"]) {
      expect(
        inferenceServerFromDraft({ ...draft, maxConcurrentRequests }, new Set(), target),
      ).toEqual(
        Result.fail({
          maxConcurrentRequests: "Enter a whole number of 1 or more, or leave it empty.",
        }),
      );
    }
  });

  it("omits an empty API key so editing keeps a saved one", () => {
    const target = {
      mode: "edit",
      id: InferenceServerIdSchema.make("rtx"),
      enabled: true,
    } as const;
    const edited = inferenceServerFromDraft({ ...draft, name: "RTX" }, new Set(["rtx"]), target);
    expect(Result.isSuccess(edited) && "apiKey" in edited.success).toBe(false);
  });

  it("types the id as a branded server id", () => {
    const result = inferenceServerFromDraft({ ...draft, name: "RTX" }, new Set(), { mode: "add" });
    expect(Result.isSuccess(result) && (result.success.id as InferenceServerId)).toBe("rtx");
  });
});

describe("inferenceServerOffers", () => {
  const rtx = InferenceServerIdSchema.make("glm-rtx");
  const spark = InferenceServerIdSchema.make("spark1");
  const origin = {
    [rtx]: { baseUrl: "http://localhost:8888/v1", enabled: true },
    [spark]: { displayName: "Spark", baseUrl: "http://spark1:8000/v1", enabled: true },
  };

  it("offers the origin's servers at the address another machine reaches", () => {
    expect(inferenceServerOffers({}, { servers: origin, host: "rtx" })).toEqual([
      { id: rtx, name: "glm-rtx", baseUrl: "http://rtx:8888/v1", needsKey: false },
      { id: spark, name: "Spark", baseUrl: "http://spark1:8000/v1", needsKey: false },
    ]);
    expect(
      inferenceServerOffers(
        {},
        { servers: origin, host: "rtx", keyedServerIds: new Set([spark]) },
      )[1]?.needsKey,
    ).toBe(true);
  });

  it("skips servers this machine has by id or by address", () => {
    const current = {
      [InferenceServerIdSchema.make("other")]: {
        baseUrl: "http://rtx:8888/v1",
        enabled: true,
      },
      [spark]: { baseUrl: "http://elsewhere/v1", enabled: true },
    };
    expect(inferenceServerOffers(current, { servers: origin, host: "rtx" })).toEqual([]);
  });

  it("names the origin by its label, else by a LAN endpoint", () => {
    expect(inferenceServerOriginHost("rtx")).toBe("rtx");
    expect(
      inferenceServerOriginHost("Zurih's desktop", [
        { kind: "lan", httpBaseUrl: "http://192.168.1.122:3773" },
        { kind: "tailnet", httpBaseUrl: "http://100.64.0.2:3773" },
      ]),
    ).toBe("192.168.1.122");
    expect(inferenceServerOriginHost("My PC")).toBeNull();
  });
});

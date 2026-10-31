import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  EnvironmentHttpApi,
  EnvironmentId,
  ScheduledTaskWebhookDeliveryId,
  ScheduledTaskError,
} from "@t3tools/contracts";
import {
  ScheduledTaskService,
  type WebhookTriggerRequest,
  type WebhookTriggerResult,
} from "./ScheduledTaskService.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { WEBHOOK_MAX_BODY_BYTES } from "./webhookRoute.ts";
import * as WebhookRoute from "./webhookRoute.ts";

class WebhookTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.webhooks) {}

const environmentId = EnvironmentId.make("env-1");
const handlerFor = (
  trigger: (
    request: WebhookTriggerRequest,
  ) => Effect.Effect<WebhookTriggerResult, ScheduledTaskError>,
) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(WebhookTestApi).pipe(
      Layer.provide(WebhookRoute.layer),
      Layer.provide(Layer.mock(ScheduledTaskService)({ triggerWebhook: trigger })),
      Layer.provide(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(NodeServices.layer),
    ),
    { disableLogger: true },
  );

const post = (
  path: string,
  body: string | Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
) => new Request(`http://env.local${path}`, { method: "POST", body, headers });

describe("webhook route", () => {
  it("maps service outcomes to status codes and names each outcome", async () => {
    const deliveryId = ScheduledTaskWebhookDeliveryId.make("delivery:1");
    const cases: ReadonlyArray<[WebhookTriggerResult, number, string]> = [
      [{ _tag: "accepted", deliveryId, outcome: "accepted" }, 202, "accepted"],
      [{ _tag: "accepted", deliveryId, outcome: "duplicate" }, 202, "duplicate"],
      [{ _tag: "accepted", deliveryId, outcome: "prompt_too_long" }, 202, "prompt_too_long"],
      [{ _tag: "accepted", deliveryId, outcome: "filtered" }, 202, "filtered"],
      [{ _tag: "not_found" }, 404, "not_found"],
      [{ _tag: "rejected_signature" }, 401, "rejected_signature"],
      [{ _tag: "disabled" }, 409, "disabled"],
      [{ _tag: "rate_limited", outcome: "rate_limited" }, 429, "rate_limited"],
      [{ _tag: "rate_limited", outcome: "queue_full" }, 429, "queue_full"],
      [{ _tag: "expired" }, 410, "expired"],
    ];
    for (const [result, status, outcome] of cases) {
      const { handler, dispose } = handlerFor(() => Effect.succeed(result));
      try {
        const response = await handler(post("/api/hooks/id/tok", "{}"));
        expect(response.status).toBe(status);
        expect(response.headers.get("x-t3-hook-outcome")).toBe(outcome);
        if (status === 429) expect(await response.json()).toEqual({ error: outcome });
      } finally {
        await dispose();
      }
    }
  });

  it("rejects oversized bodies and malformed paths before reaching the service", async () => {
    let calls = 0;
    const { handler, dispose } = handlerFor(() => {
      calls += 1;
      return Effect.succeed({ _tag: "not_found" });
    });
    try {
      const big = new Uint8Array(WEBHOOK_MAX_BODY_BYTES + 1);
      expect((await handler(post("/api/hooks/id/tok", big))).status).toBe(413);
      expect((await handler(post("/api/hooks/id", "{}"))).status).toBe(404);
      expect((await handler(post("/api/hooks/id/tok/extra", "{}"))).status).toBe(404);
      expect((await handler(post("/api/hooks/%E0/tok", "{}"))).status).toBe(404);
      const chunked = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let sent = 0; sent <= WEBHOOK_MAX_BODY_BYTES; sent += 64 * 1024) {
            controller.enqueue(new Uint8Array(64 * 1024));
          }
          controller.close();
        },
      });
      const streamed = await handler(
        new Request("http://env.local/api/hooks/id/tok", {
          method: "POST",
          body: chunked,
          // Node's fetch needs duplex for streamed bodies.
          duplex: "half",
        }),
      );
      expect(streamed.status).toBe(413);
      expect(calls).toBe(0);
    } finally {
      await dispose();
    }
  });

  it("hides service failures and defects behind a fixed 500", async () => {
    const failures = [
      Effect.fail(new ScheduledTaskError({ message: "database locked" })),
      Effect.die(new Error("database exploded")),
    ];
    for (const failure of failures) {
      const { handler, dispose } = handlerFor(() => failure);
      try {
        const response = await handler(post("/api/hooks/id/tok", "{}"));
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "internal_error" });
      } finally {
        await dispose();
      }
    }
  });
});

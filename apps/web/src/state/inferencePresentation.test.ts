import {
  InferenceServerId,
  type InferenceServerSnapshot,
} from "@houston-app/contracts/houston/inference";
import { describe, expect, it } from "vite-plus/test";

import { inferenceModelNotServed, inferenceServerOutage } from "./inferencePresentation";

describe("inferenceServerOutage", () => {
  const rtx = InferenceServerId.make("rtx");
  const snapshot = (status: InferenceServerSnapshot["status"]): InferenceServerSnapshot => ({
    id: rtx,
    displayName: "rtx",
    baseUrl: "http://localhost:8888/v1",
    enabled: true,
    status,
    checkedAt: null,
    message: "Could not connect to the server.",
    models: [],
  });
  const outage = (status: InferenceServerSnapshot["status"], enabled = true) =>
    inferenceServerOutage({
      serverId: rtx,
      servers: { [rtx]: { baseUrl: "http://localhost:8888/v1", enabled } },
      snapshots: [snapshot(status)],
    });

  it("reports an enabled linked server that is down, not one being checked or turned off", () => {
    expect(outage("unreachable")).toEqual({
      id: rtx,
      name: "rtx",
      baseUrl: "http://localhost:8888/v1",
      message: "Could not connect to the server.",
    });
    expect(outage("checking")).toBeNull();
    expect(outage("unreachable", false)).toBeNull();
  });
});

describe("inferenceModelNotServed", () => {
  const rtx = InferenceServerId.make("rtx");
  const ready = (
    models: ReadonlyArray<string>,
    status: InferenceServerSnapshot["status"] = "ready",
  ) => [
    {
      id: rtx,
      displayName: "rtx",
      baseUrl: "http://localhost:8888/v1",
      enabled: true,
      status,
      checkedAt: null,
      models: models.map((id) => ({ id })),
    } satisfies InferenceServerSnapshot,
  ];
  const servers = { [rtx]: { baseUrl: "http://localhost:8888/v1", enabled: true } };
  const check = (
    modelSlug: string,
    snapshots: ReadonlyArray<InferenceServerSnapshot>,
    driver = "pi",
  ) => inferenceModelNotServed({ serverId: rtx, driver, modelSlug, servers, snapshots });

  it("reports a gateway model a ready server no longer lists, with what it serves now", () => {
    expect(check("houston-rtx/GLM-5.3-Flash", ready(["DeepSeek-V4.1-Flash"]))).toEqual({
      id: rtx,
      name: "rtx",
      model: "GLM-5.3-Flash",
      served: ["DeepSeek-V4.1-Flash"],
    });
    expect(check("GLM-5.3-Flash", ready(["DeepSeek-V4.1-Flash"]), "codex")?.model).toBe(
      "GLM-5.3-Flash",
    );
  });

  it("says nothing while the model is served, the server is not ready, or the model is the agent's own", () => {
    expect(check("houston-rtx/GLM-5.3-Flash", ready(["GLM-5.3-Flash"]))).toBeNull();
    expect(check("houston-rtx/GLM-5.3-Flash", ready([], "unreachable"))).toBeNull();
    expect(check("houston-rtx/GLM-5.3-Flash", ready(["DeepSeek"], "checking"))).toBeNull();
    expect(check("tensorfold/GLM-5.3-Flash", ready(["DeepSeek"]))).toBeNull();
  });
});

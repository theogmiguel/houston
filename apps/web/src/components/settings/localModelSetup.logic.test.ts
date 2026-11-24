import { ProviderDriverKind, ProviderInstanceId } from "@houston-app/contracts";
import { InferenceServerId } from "@houston-app/contracts/houston/inference";
import { describe, expect, it } from "vite-plus/test";

import {
  linkedModelSlug,
  localModelAgentChoices,
  planLocalModelSetup,
  repairCandidates,
} from "./localModelSetup.logic";

const pi = ProviderDriverKind.make("pi");
const codex = ProviderDriverKind.make("codex");
const rtx = InferenceServerId.make("rtx");

describe("localModelAgentChoices", () => {
  it("offers Pi then OpenCode, the first installed one recommended, and leaves other agents out", () => {
    const choices = localModelAgentChoices(
      { apiProtocols: ["chat-completions"] },
      [
        { driver: pi, installed: true, enabled: true },
        { driver: ProviderDriverKind.make("opencode"), installed: false, enabled: true },
        { driver: codex, installed: true, enabled: true },
      ],
      "rtx",
    );
    expect(choices.map((choice) => choice.driver)).toEqual([
      pi,
      ProviderDriverKind.make("opencode"),
    ]);
    expect(choices[0]).toMatchObject({ label: "Pi", recommended: true });
    expect(choices[1]).toMatchObject({
      label: "OpenCode",
      unavailableReason: "OpenCode is not installed on rtx.",
      recommended: false,
    });
    expect(
      localModelAgentChoices({}, [{ driver: pi, installed: true, enabled: true }], "rtx").some(
        (choice) => choice.recommended,
      ),
    ).toBe(false);
  });
});

describe("planLocalModelSetup", () => {
  const moved = { baseUrl: "http://localhost:8030/v1" };

  it("adds a server and a linked local agent", () => {
    expect(
      planLocalModelSetup({
        settings: {
          inferenceServers: {
            [rtx]: { baseUrl: "http://localhost:8888/v1", enabled: true },
          },
          providerInstances: {},
        },
        server: moved,
        driver: pi,
        agentLabel: "Pi",
        machineLabel: "rtx",
      }),
    ).toEqual({
      serverId: "rtx-8030",
      serverName: "rtx :8030",
      serverConfig: {
        displayName: "rtx :8030",
        baseUrl: "http://localhost:8030/v1",
        enabled: true,
      },
      instanceId: "pi-rtx-8030",
      instanceMutation: {
        operation: "create",
        instanceId: "pi-rtx-8030",
        instance: {
          driver: pi,
          displayName: "Pi · rtx :8030",
          inference: "local",
          inferenceServerId: "rtx-8030",
          enabled: true,
        },
      },
    });
  });

  it("changes nothing when the server and its linked agent already exist", () => {
    const linkedPi = ProviderInstanceId.make("pi_rtx");
    const settings = {
      inferenceServers: {
        [rtx]: { baseUrl: "http://localhost:8030/v1", enabled: true },
      },
      providerInstances: {
        [linkedPi]: { driver: pi, inference: "local" as const, inferenceServerId: rtx },
      },
    };
    for (const server of [{ ...moved, registeredServerId: rtx }, moved]) {
      const plan = planLocalModelSetup({
        settings,
        server,
        driver: pi,
        agentLabel: "Pi",
        machineLabel: "rtx",
      });
      expect(plan).toMatchObject({ serverId: rtx, serverConfig: null, instanceId: linkedPi });
      expect(plan?.instanceMutation).toBeNull();
    }
  });

  it("turns a registered server and its linked agent back on instead of adding new ones", () => {
    const linkedPi = ProviderInstanceId.make("pi_rtx");
    const plan = planLocalModelSetup({
      settings: {
        inferenceServers: {
          [rtx]: { baseUrl: "http://localhost:8030/v1", enabled: false },
        },
        providerInstances: {
          [linkedPi]: {
            driver: pi,
            inference: "local" as const,
            inferenceServerId: rtx,
            enabled: false,
          },
        },
      },
      server: { ...moved, registeredServerId: rtx },
      driver: pi,
      agentLabel: "Pi",
      machineLabel: "rtx",
    });
    expect(plan?.serverConfig?.enabled).toBe(true);
    expect(plan?.instanceMutation).toEqual({
      operation: "upsert",
      instanceId: linkedPi,
      instance: {
        driver: pi,
        inference: "local",
        inferenceServerId: rtx,
        enabled: true,
      },
    });
  });
});

describe("linkedModelSlug", () => {
  it("prefers the gateway's entry over the agent's own config for the same model", () => {
    expect(
      linkedModelSlug(
        [{ slug: "tensorfold/GLM-5.3-Flash" }, { slug: "houston-rtx/GLM-5.3-Flash" }],
        rtx,
        "GLM-5.3-Flash",
      ),
    ).toBe("houston-rtx/GLM-5.3-Flash");
    expect(linkedModelSlug([{ slug: "GLM-5.3-Flash" }], rtx, "GLM-5.3-Flash")).toBe(
      "GLM-5.3-Flash",
    );
    expect(linkedModelSlug([{ slug: "houston-rtx/GLM-5" }], rtx, "GLM-5.3-Flash")).toBeUndefined();
  });
});

describe("repairCandidates", () => {
  const server = (baseUrl: string, models: ReadonlyArray<string>) => ({
    baseUrl,
    status: "ready" as const,
    models: models.map((id) => ({ id })),
  });

  it("ranks a server that serves a known model first and ignores the old address", () => {
    const found = repairCandidates(
      [
        server("http://localhost:8888/v1", ["GLM-5.3-Flash"]),
        server("http://localhost:8030/v1", ["GLM-5.3-Flash"]),
        server("http://localhost:9100/v1", ["Qwen"]),
      ],
      rtx,
      "http://localhost:8888/v1",
      new Set(["GLM-5.3-Flash"]),
    );
    expect(found.map((entry) => [entry.server.baseUrl, entry.sameModel])).toEqual([
      ["http://localhost:8030/v1", true],
      ["http://localhost:9100/v1", false],
    ]);
  });
});

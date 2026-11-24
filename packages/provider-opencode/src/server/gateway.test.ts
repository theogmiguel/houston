import { assert, describe, it } from "@effect/vitest";

import { OPENCODE_GATEWAY_TOKEN_ENV, withOpenCodeGateway } from "./gateway.ts";

const server = {
  serverId: "rtx",
  displayName: "rtx",
  models: [{ id: "glm", contextWindow: 8_192, maxOutputTokens: 4_096 }],
};

describe("withOpenCodeGateway", () => {
  it("adds the gateway provider to the existing overlay and keeps its token in the environment", () => {
    const environment = withOpenCodeGateway(
      { OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "dark" }) },
      {
        server,
        credential: { serverId: "rtx", baseUrl: "http://gw/inference/rtx/v1", token: "t" },
      },
    );
    assert.equal(environment[OPENCODE_GATEWAY_TOKEN_ENV], "t");
    const overlay = JSON.parse(environment.OPENCODE_CONFIG_CONTENT!);
    assert.equal(overlay.theme, "dark");
    assert.deepEqual(overlay.provider["houston-rtx"].options, {
      baseURL: "http://gw/inference/rtx/v1",
      apiKey: `{env:${OPENCODE_GATEWAY_TOKEN_ENV}}`,
    });
    assert.deepEqual(overlay.provider["houston-rtx"].models.glm.limit, {
      context: 8_192,
      output: 4_096,
    });
  });

  it("leaves an unparseable overlay alone", () => {
    const environment = { OPENCODE_CONFIG_CONTENT: "not json" };
    assert.equal(
      withOpenCodeGateway(environment, {
        server,
        credential: { serverId: "rtx", baseUrl: "http://gw", token: "t" },
      }),
      environment,
    );
  });
});

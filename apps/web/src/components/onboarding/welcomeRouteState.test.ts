import { describe, expect, it } from "vite-plus/test";

import { readWelcomeRouteState } from "./welcomeRouteState";

const ENVIRONMENT_ID = "8ed5427d-123e-462e-93e6-5274eeeb3503";

describe("readWelcomeRouteState", () => {
  it("opens setup for the hash the router stores without a leading #", () => {
    expect(readWelcomeRouteState("setup")).toEqual({
      setupRequested: true,
      resumeEnvironmentId: undefined,
    });
  });

  it("does not treat a raw fragment as the setup anchor", () => {
    expect(readWelcomeRouteState("#setup").setupRequested).toBe(false);
  });

  it("resumes provider setup for an environment hash", () => {
    expect(readWelcomeRouteState(`agents:${ENVIRONMENT_ID}`)).toEqual({
      setupRequested: true,
      resumeEnvironmentId: ENVIRONMENT_ID,
    });
  });

  it("ignores an unparseable environment hash", () => {
    expect(readWelcomeRouteState("agents:")).toEqual({
      setupRequested: false,
      resumeEnvironmentId: undefined,
    });
  });
});

import { describe, expect, it } from "vite-plus/test";

import { projectKeyOf } from "./projectKey.ts";

describe("projectKeyOf", () => {
  it("joins the environment and project ids, so equal project ids in two environments differ", () => {
    expect(projectKeyOf("env-1", "project-a")).toBe("env-1:project-a");
    expect(projectKeyOf("env-1", "project-a")).not.toBe(projectKeyOf("env-2", "project-a"));
  });
});

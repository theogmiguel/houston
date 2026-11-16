import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HoustonTaskGetInput,
  HoustonTaskKey,
  HoustonTaskRef,
  HoustonTaskSubscribeInput,
  houstonTaskKey,
  parseHoustonTaskRef,
} from "./tasks.ts";

const decodeRef = Schema.decodeUnknownExit(HoustonTaskRef);
const decodeKey = Schema.decodeUnknownExit(HoustonTaskKey);
const decodeGet = Schema.decodeExit(HoustonTaskGetInput);
const decodeScope = Schema.decodeUnknownExit(HoustonTaskSubscribeInput);

describe("task ids decode in every form", () => {
  it("HOU-42, hou-42 and a decimal id decode; HOU-0 and HOU-x do not", () => {
    for (const ref of ["HOU-42", "hou-42", "Hou-42", "42"]) {
      expect(decodeRef(ref)._tag, ref).toBe("Success");
    }
    for (const ref of ["HOU-0", "HOU-x", "HOU-", "0", "-1", "4.2", "HOU-042", "", 42]) {
      expect(decodeRef(ref)._tag, String(ref)).toBe("Failure");
    }
  });

  it("a key in any letter case names the same number; a decimal is a task id", () => {
    expect(parseHoustonTaskRef("HOU-42")).toEqual({ kind: "number", number: 42 });
    expect(parseHoustonTaskRef("hou-42")).toEqual({ kind: "number", number: 42 });
    expect(parseHoustonTaskRef("42")).toEqual({ kind: "id", id: 42 });
  });

  it("the display key is HOU-<number> and only that shape decodes as a key", () => {
    expect(houstonTaskKey(7)).toBe("HOU-7");
    expect(decodeKey("HOU-7")._tag).toBe("Success");
    expect(decodeKey("hou-7")._tag).toBe("Failure");
    expect(decodeKey("HOU-0")._tag).toBe("Failure");
  });

  it("get and subscribe inputs carry the id and the scope", () => {
    expect(decodeGet({ id: "hou-3" })._tag).toBe("Success");
    expect(decodeScope({ scope: "all" })._tag).toBe("Success");
    expect(decodeScope({ scope: "unassigned" })._tag).toBe("Success");
    expect(decodeScope({ scope: { projectId: "project-1" } })._tag).toBe("Success");
    expect(decodeScope({ scope: "mine" })._tag).toBe("Failure");
  });
});

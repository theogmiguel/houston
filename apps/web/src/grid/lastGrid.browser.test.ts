import { expect, it } from "vite-plus/test";

import { readLastOpenGridId, rememberLastOpenGridId } from "./lastGrid";

it("remembers the grid last on screen for the next launch", () => {
  window.localStorage.clear();
  expect(readLastOpenGridId()).toBeNull();
  rememberLastOpenGridId("grid-7");
  expect(readLastOpenGridId()).toBe("grid-7");
  window.localStorage.clear();
});

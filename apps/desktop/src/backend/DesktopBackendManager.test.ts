import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { restartRefusalReason } from "./DesktopBackendManager.ts";

const readyServer = {
  attached: false,
  desiredRunning: true,
  ready: true,
  activePid: Option.some(4242),
} as const;

describe("restartRefusalReason", () => {
  it("allows a restart of the app's own ready server", () => {
    assert.isTrue(Option.isNone(restartRefusalReason(readyServer)));
  });

  it("refuses an attached server the app does not own", () => {
    const reason = restartRefusalReason({ ...readyServer, attached: true });
    assert.isTrue(Option.isSome(reason));
    if (Option.isSome(reason)) {
      assert.include(reason.value, "does not own");
      assert.include(reason.value, "Quit that server yourself");
    }
  });

  it("refuses while a start is in flight so it never kills a booting server", () => {
    const reason = restartRefusalReason({ ...readyServer, ready: false });
    assert.isTrue(Option.isSome(reason));
    if (Option.isSome(reason)) {
      assert.include(reason.value, "already in progress");
    }
  });

  it("allows a restart after a crash when no run is active", () => {
    assert.isTrue(
      Option.isNone(
        restartRefusalReason({
          ...readyServer,
          ready: false,
          activePid: Option.none(),
        }),
      ),
    );
  });
});

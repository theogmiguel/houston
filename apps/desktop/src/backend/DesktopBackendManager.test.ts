import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

import {
  BACKEND_QUIT_STOP_TIMEOUT,
  readinessPollDelay,
  restartRefusalReason,
} from "./DesktopBackendManager.ts";

const readyServer = {
  attached: false,
  desiredRunning: true,
  ready: true,
  active: true,
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
          active: false,
        }),
      ),
    );
  });
});

describe("readinessPollDelay", () => {
  it("polls at least 20 times in the first second then backs off", () => {
    let elapsed = Duration.zero;
    let probes = 0;
    while (Duration.toMillis(elapsed) < 1_000) {
      elapsed = Duration.sum(elapsed, readinessPollDelay(elapsed));
      probes += 1;
    }

    assert.isAtLeast(probes, 20);
    assert.equal(Duration.toMillis(readinessPollDelay(Duration.seconds(2))), 100);
    assert.equal(Duration.toMillis(readinessPollDelay(Duration.seconds(5))), 250);
    assert.equal(Duration.toMillis(readinessPollDelay(Duration.seconds(170))), 250);
  });
});

describe("BACKEND_QUIT_STOP_TIMEOUT", () => {
  it("leaves room for the force kill after the SIGTERM grace", () => {
    // The spawner sends SIGTERM and waits a 5 s grace before SIGKILL; quit must outwait both.
    assert.isAtLeast(Duration.toMillis(BACKEND_QUIT_STOP_TIMEOUT), 6_000);
  });
});

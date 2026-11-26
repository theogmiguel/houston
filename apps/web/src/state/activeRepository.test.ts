import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { scopedThreadKey } from "@houston-app/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectActiveRepositoryKey, useActiveRepositoryStore } from "./activeRepository";

const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const otherRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("other") };

describe("activeRepositoryStore", () => {
  beforeEach(() => {
    useActiveRepositoryStore.setState({ byThreadKey: {} });
  });

  it("keeps one active repository per thread", () => {
    const store = useActiveRepositoryStore.getState();
    store.setActiveRepository(ref, "api");
    store.setActiveRepository(otherRef, "web");
    store.setActiveRepository(ref, null);

    const state = useActiveRepositoryStore.getState();
    expect(selectActiveRepositoryKey(state, ref)).toBeNull();
    expect(selectActiveRepositoryKey(state, otherRef)).toBe("web");
    expect(selectActiveRepositoryKey(state, null)).toBeNull();
  });

  it("drops only the removed thread's selection", () => {
    const store = useActiveRepositoryStore.getState();
    store.setActiveRepository(ref, "api");
    store.setActiveRepository(otherRef, "web");
    store.removeThread(ref);

    const state = useActiveRepositoryStore.getState();
    expect(state.byThreadKey[scopedThreadKey(ref)]).toBeUndefined();
    expect(selectActiveRepositoryKey(state, otherRef)).toBe("web");
  });
});

// The linked-machine search hook: a retry asks only the machines that failed, starts from what
// already answered, and gives way to a fresh search when the query changes.
import { EnvironmentId } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import type { LinkedSearchMachine, LinkedSearchState } from "./queries";

const state = vi.hoisted(() => ({
  primary: "env-primary" as string | null,
  current: { enabled: true, started: true, machines: [] } as LinkedSearchState,
  subscriptions: [] as Array<{ readonly method: string; readonly input: unknown }>,
  followed: [] as Array<{ readonly environmentId: unknown; readonly stream: unknown }>,
}));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => AsyncResult.success(state.current),
}));
vi.mock("@houston-app/client-runtime/rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@houston-app/client-runtime/rpc")>()),
  subscribe: (method: string, input: unknown) => {
    state.subscriptions.push({ method, input });
    return Stream.empty;
  },
}));
vi.mock("@houston-app/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@houston-app/client-runtime/state/runtime")>()),
  followStreamInEnvironment: (environmentId: unknown, stream: unknown) => {
    state.followed.push({ environmentId, stream });
    return { followed: state.followed.length };
  },
}));
vi.mock("../connection/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../connection/runtime")>();
  return {
    ...actual,
    connectionAtomRuntime: new Proxy(actual.connectionAtomRuntime, {
      get: (target, property, receiver) =>
        property === "atom"
          ? (source: unknown) => ({ source })
          : Reflect.get(target, property, receiver),
    }),
  };
});
vi.mock("./environments", () => ({ usePrimaryEnvironmentId: () => state.primary }));
vi.mock("./filesystem", () => ({ useFilesystemReadAccess: vi.fn() }));
vi.mock("./orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("./threads", () => ({ olderSettledThreads: {}, threadFamilies: {} }));
vi.mock("./paginatedBranches", () => ({ isPaginatedBranchesNextPagePending: vi.fn() }));
vi.mock("./projects", () => ({ projectContentSearch: vi.fn(), projectEnvironment: {} }));
vi.mock("./query", () => ({ useEnvironmentQuery: vi.fn() }));
vi.mock("./vcs", () => ({ vcsEnvironment: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));

import { useLinkedThreadSearch } from "./queries";

const machine = (id: string, status: LinkedSearchMachine["status"]): LinkedSearchMachine => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  access: "full-access",
  host: `${id}.example`,
  status,
  matches: [],
});

const firstAnswered: LinkedSearchState = {
  enabled: true,
  started: true,
  machines: [machine("env-a", "ok"), machine("env-b", "unreachable")],
};
const allAnswered: LinkedSearchState = {
  enabled: true,
  started: true,
  machines: [machine("env-a", "ok"), machine("env-b", "ok")],
};

function Host(props: { readonly query: string }) {
  const search = useLinkedThreadSearch(props.query);
  return (
    <>
      <output>{search.failed.map((failed) => failed.environmentId).join(",")}</output>
      <button type="button" onClick={search.retry}>
        Retry
      </button>
    </>
  );
}

const searchInputs = () => state.subscriptions.map((subscription) => subscription.input);

/** Starts each test from the same state; disposing it leaves nothing behind. */
function freshState(current: LinkedSearchState = firstAnswered): Disposable {
  state.primary = "env-primary";
  state.current = current;
  state.subscriptions.length = 0;
  state.followed.length = 0;
  return {
    [Symbol.dispose]: () => {
      state.subscriptions.length = 0;
      state.followed.length = 0;
    },
  };
}

describe("useLinkedThreadSearch retry", () => {
  it("asks only the machines that failed and starts from what already answered", async () => {
    using _state = freshState();
    await using screen = await render(<Host query="fix" />, { router: false });
    await vi.waitFor(() => expect(searchInputs()).toEqual([{ query: "fix" }]));
    await expect.element(screen.getByRole("status")).toHaveTextContent("env-b");

    state.current = allAnswered;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await vi.waitFor(() =>
      expect(searchInputs()).toEqual([
        { query: "fix" },
        { query: "fix", environmentIds: ["env-b"] },
      ]),
    );
    const retried = state.followed.at(-1)?.stream as Stream.Stream<LinkedSearchState>;
    // oxlint-disable-next-line houston/no-manual-effect-runtime-in-tests -- reads the stream the hook built, outside any Effect test runtime
    const [seed] = await Effect.runPromise(Stream.runCollect(retried));
    expect(seed).toEqual(firstAnswered);
  });

  it("does nothing when every machine answered", async () => {
    using _state = freshState(allAnswered);
    await using screen = await render(<Host query="fix" />, { router: false });
    await vi.waitFor(() => expect(searchInputs()).toEqual([{ query: "fix" }]));

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(searchInputs()).toEqual([{ query: "fix" }]);
  });

  it("starts a fresh search for a new query instead of retrying the old one", async () => {
    using _state = freshState();
    await using screen = await render(<Host query="fix" />, { router: false });
    await vi.waitFor(() => expect(searchInputs()).toEqual([{ query: "fix" }]));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(searchInputs()).toHaveLength(2));

    await screen.rerender(<Host query="fix two" />);

    await vi.waitFor(() => expect(searchInputs().at(-1)).toEqual({ query: "fix two" }));
  });
});

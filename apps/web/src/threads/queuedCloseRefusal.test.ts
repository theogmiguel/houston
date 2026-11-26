import { EnvironmentId, RunId, ThreadId, type ScopedThreadRef } from "@houston-app/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { loadCatalogue, translate } from "~/i18n/translate";
import type { Translate } from "~/i18n/useT";

interface ShownToast {
  readonly id?: string;
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly timeout?: number;
  readonly actionProps?: { readonly children: string; readonly onClick: () => void };
  readonly data?: {
    readonly secondaryActionVariant?: string;
    readonly secondaryActionProps?: { readonly children: string; readonly onClick: () => void };
  };
}

const toasts = vi.hoisted(() => ({ shown: [] as unknown[], closed: [] as string[] }));
vi.mock("../components/ui/toast", async () => ({
  stackedThreadToast: (await import("../components/ui/toastHelpers")).stackedThreadToast,
  toastManager: {
    add: (toast: unknown) => {
      toasts.shown.push(toast);
      return "toast";
    },
    close: (id: string) => toasts.closed.push(id),
  },
}));

import { queuedCloseRefusalToastId, showQueuedCloseRefusal } from "./queuedCloseRefusal";

const thread = (id: string): ScopedThreadRef => ({
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make(id),
});
const runIds = (...ids: string[]) => ids.map((id) => RunId.make(id));
const english: Translate = (source, params) => translate("en", source, params);
const succeeds = () => Promise.resolve(AsyncResult.success(undefined));
const fails = (message: string) =>
  Promise.resolve(AsyncResult.failure(Cause.fail(new Error(message))));
const shown = () => toasts.shown as ShownToast[];
const lastToast = () => shown().at(-1)!;
/** The fakes settle in microtasks, so a few turns run an action to its end. */
const flush = async () => {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
};

/** A queue that answers like the server: only a queued run can be removed. */
function makeThread(id: string, queued: string[]) {
  const queue = runIds(...queued);
  const requests: string[] = [];
  const target = thread(id);
  let closed = false;
  const close = async () => {
    requests.push("close");
    if (queue.length > 0) return refuse();
    closed = true;
  };
  const refuse = () =>
    showQueuedCloseRefusal({
      target,
      title: id,
      runIds: [...queue],
      translate: english,
      send: (runId) => {
        requests.push(`send ${runId}`);
        return succeeds();
      },
      remove: (runId) => {
        requests.push(`remove ${runId}`);
        const index = queue.indexOf(runId);
        if (index === -1) return fails(`Run ${runId} is not queued.`);
        queue.splice(index, 1);
        return succeeds();
      },
      close,
    });
  return { queue, requests, refuse, isClosed: () => closed, target };
}

beforeEach(() => {
  toasts.shown = [];
  toasts.closed = [];
});

describe("a close refused by queued messages", () => {
  it("offers to send the queued message or remove it, and stays until answered", () => {
    makeThread("Fix login", ["run-1"]).refuse();

    expect(lastToast()).toMatchObject({
      type: "warning",
      title: "Failed to close thread",
      description: "“Fix login” has a queued message.",
      timeout: 0,
      actionProps: { children: "Send now" },
      data: {
        secondaryActionProps: { children: "Remove and close" },
        secondaryActionVariant: "destructive-outline",
      },
    });
  });

  it("counts the messages the removal would discard", () => {
    makeThread("Fix login", ["run-1", "run-2", "run-3"]).refuse();

    expect(lastToast().description).toBe("“Fix login” has 3 queued messages.");
    expect(lastToast().data?.secondaryActionProps?.children).toBe("Remove 3 and close");
  });

  it("says one and several in Brazilian Portuguese", async () => {
    await loadCatalogue("pt-BR");
    const refuse = (...ids: string[]) => {
      showQueuedCloseRefusal({
        target: thread("one"),
        title: "Corrigir login",
        runIds: runIds(...ids),
        translate: (source, params) => translate("pt-BR", source, params),
        send: succeeds,
        remove: succeeds,
        close: async () => {},
      });
      const toast = lastToast();
      return [
        toast.description,
        toast.actionProps?.children,
        toast.data?.secondaryActionProps?.children,
      ];
    };

    expect(refuse("run-1")).toEqual([
      "“Corrigir login” tem uma mensagem na fila.",
      "Enviar agora",
      "Remover e fechar",
    ]);
    expect(refuse("run-1", "run-2")).toEqual([
      "“Corrigir login” tem 2 mensagens na fila.",
      "Enviar agora",
      "Remover 2 e fechar",
    ]);
  });

  it("replaces its own notice and leaves another thread's in place", () => {
    const first = makeThread("one", ["run-1"]);
    const second = makeThread("two", ["run-2"]);
    first.refuse();
    first.refuse();
    second.refuse();

    const ids = shown().map((toast) => toast.id);
    expect(ids[0]).toBe(queuedCloseRefusalToastId(first.target));
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });
});

describe("Send now", () => {
  it("sends the first queued message and does not close the thread", async () => {
    const { requests, refuse, target } = makeThread("one", ["run-1", "run-2"]);
    refuse();
    lastToast().actionProps!.onClick();
    await flush();

    expect(requests).toEqual(["send run-1"]);
    expect(toasts.closed).toEqual([queuedCloseRefusalToastId(target)]);
    expect(shown()).toHaveLength(1);
  });

  it("shows why a send was refused", async () => {
    showQueuedCloseRefusal({
      target: thread("one"),
      title: "one",
      runIds: runIds("run-1"),
      translate: english,
      send: () => fails("Continue the limited thread before resuming its queue."),
      remove: succeeds,
      close: async () => {},
    });
    lastToast().actionProps!.onClick();
    await flush();

    expect(lastToast()).toMatchObject({
      type: "error",
      title: "Failed to send queued message",
      description: "Continue the limited thread before resuming its queue.",
    });
  });
});

describe("Remove and close", () => {
  it("removes every message the refusal named, then closes", async () => {
    const { requests, refuse, isClosed } = makeThread("one", ["run-1", "run-2"]);
    refuse();
    lastToast().data!.secondaryActionProps!.onClick();
    await flush();

    expect(requests).toEqual(["remove run-1", "remove run-2", "close"]);
    expect(isClosed()).toBe(true);
  });

  it("keeps a message queued after the refusal and says the close is refused again", async () => {
    const { queue, requests, refuse, isClosed } = makeThread("one", ["run-1"]);
    refuse();
    queue.push(RunId.make("run-later"));
    lastToast().data!.secondaryActionProps!.onClick();
    await flush();

    expect(requests).toEqual(["remove run-1", "close"]);
    expect(queue).toEqual(["run-later"]);
    expect(isClosed()).toBe(false);
    expect(shown()).toHaveLength(2);
    expect(lastToast().description).toBe("“one” has a queued message.");
  });

  it("stops at the first message it cannot remove, names it and leaves the rest", async () => {
    const { queue, requests, refuse, isClosed } = makeThread("one", ["run-1", "run-2", "run-3"]);
    refuse();
    queue.splice(1, 1);
    lastToast().data!.secondaryActionProps!.onClick();
    await flush();

    expect(requests).toEqual(["remove run-1", "remove run-2"]);
    expect(queue).toEqual(["run-3"]);
    expect(isClosed()).toBe(false);
    expect(lastToast()).toMatchObject({
      type: "error",
      title: "Queued message 2 of 3 was not removed",
      description: "Run run-2 is not queued.",
    });
  });

  it("names the only message without a position", async () => {
    const { queue, refuse } = makeThread("one", ["run-1"]);
    refuse();
    queue.splice(0, 1);
    lastToast().data!.secondaryActionProps!.onClick();
    await flush();

    expect(lastToast().title).toBe("Queued message was not removed");
  });

  it.each([
    { count: 1, title: "Removing the queued message was interrupted", removed: 0 },
    { count: 3, title: "Removing queued message 2 of 3 was interrupted", removed: 1 },
  ])("says how far an interrupted removal of $count got", async ({ count, title, removed }) => {
    const ids = runIds("run-1", "run-2", "run-3").slice(0, count);
    const requests: string[] = [];
    showQueuedCloseRefusal({
      target: thread("one"),
      title: "one",
      runIds: ids,
      translate: english,
      send: succeeds,
      remove: (runId) => {
        requests.push(runId);
        return requests.length > removed
          ? Promise.resolve(AsyncResult.failure(Cause.interrupt()))
          : succeeds();
      },
      close: async () => {
        requests.push("close");
      },
    });
    lastToast().data!.secondaryActionProps!.onClick();
    await flush();

    expect(requests).toEqual(ids.slice(0, removed + 1));
    expect(lastToast()).toMatchObject({
      type: "error",
      title,
      description: `Removed ${removed} of ${count}. Check the queue for the rest.`,
    });
  });

  it("runs once when pressed twice, and Send now cannot follow it", async () => {
    const { requests, refuse } = makeThread("one", ["run-1"]);
    refuse();
    const toast = lastToast();
    toast.data!.secondaryActionProps!.onClick();
    toast.data!.secondaryActionProps!.onClick();
    toast.actionProps!.onClick();
    await flush();
    toast.data!.secondaryActionProps!.onClick();
    await flush();

    expect(requests).toEqual(["remove run-1", "close"]);
  });

  it("acts only on the thread its notice is about", async () => {
    const first = makeThread("one", ["run-1"]);
    const second = makeThread("two", ["run-2"]);
    first.refuse();
    const firstToast = lastToast();
    second.refuse();
    firstToast.data!.secondaryActionProps!.onClick();
    await flush();

    expect(first.requests).toEqual(["remove run-1", "close"]);
    expect(second.requests).toEqual([]);
    expect(second.queue).toEqual(["run-2"]);
    expect(toasts.closed).toEqual([queuedCloseRefusalToastId(first.target)]);
  });
});

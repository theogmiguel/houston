import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const draftStore = vi.hoisted(() => ({
  session: {} as unknown,
  promoted: null as null | { threadId: string },
}));

vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({
      getDraftSession: () => draftStore.session,
      getPromotedDraftRedirect: () => draftStore.promoted,
    }),
}));
vi.mock("../ChatView", () => ({
  default: (props: Record<string, unknown>) => (
    <div
      data-testid="chat"
      data-route-kind={String(props.routeKind)}
      data-draft-id={String(props.draftId)}
      data-centered={String(props.centerDraftComposer === true)}
    />
  ),
}));

import { render } from "../../../test/render";
import { ThreadDraftSurface, useOpenedDraft, type OpenedDraft } from "./ThreadDraftSurface";

const opened: OpenedDraft = { draftId: "draft-1" as never, threadId: ThreadId.make("thread-1") };

function Host(props: {
  readonly open: () => Promise<OpenedDraft | null>;
  readonly onPromoted: (threadId: ThreadId) => void;
  readonly onChange: (draft: { threadId: ThreadId } | null) => void;
}) {
  const draft = useOpenedDraft(props);
  return draft === null ? (
    <output data-testid="state">pending</output>
  ) : (
    <ThreadDraftSurface environmentId={EnvironmentId.make("env-1")} draft={draft} />
  );
}

describe("thread draft surface", () => {
  it("opens one draft on mount, reports it, and renders its centred composer", async () => {
    draftStore.session = {};
    draftStore.promoted = null;
    const open = vi.fn(async () => opened);
    const onChange = vi.fn();
    await using screen = await render(
      <Host open={open} onPromoted={() => {}} onChange={onChange} />,
    );

    await expect.element(screen.getByTestId("chat")).toHaveAttribute("data-route-kind", "draft");
    await expect.element(screen.getByTestId("chat")).toHaveAttribute("data-draft-id", "draft-1");
    await expect.element(screen.getByTestId("chat")).toHaveAttribute("data-centered", "true");
    expect(open).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ threadId: opened.threadId });
  });

  it("renders nothing when no draft could be opened", async () => {
    const onChange = vi.fn();
    await using screen = await render(
      <Host open={async () => null} onPromoted={() => {}} onChange={onChange} />,
    );
    await expect.element(screen.getByTestId("state")).toHaveTextContent("pending");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("hands the promoted thread over once the draft session is gone", async () => {
    draftStore.session = {};
    draftStore.promoted = null;
    const onPromoted = vi.fn();
    const props = { open: async () => opened, onPromoted, onChange: () => {} };
    await using screen = await render(<Host {...props} />);
    await expect.element(screen.getByTestId("chat")).toBeInTheDocument();
    expect(onPromoted).not.toHaveBeenCalled();

    draftStore.session = null;
    draftStore.promoted = { threadId: "thread-promoted" };
    await screen.rerender(<Host {...props} />);
    await screen.rerender(<Host {...props} />);

    expect(onPromoted).toHaveBeenCalledTimes(1);
    expect(onPromoted).toHaveBeenCalledWith("thread-promoted");
  });
});

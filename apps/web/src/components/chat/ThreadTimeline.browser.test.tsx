import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ThreadTimeline } from "./ThreadTimeline";

const timeline = vi.hoisted(() => ({
  entries: [] as ReadonlyArray<{ readonly id: string; readonly kind: string }>,
  rendered: [] as ReadonlyArray<{ readonly id: string; readonly kind: string }>,
}));

vi.mock("../../hooks/useIncrementalTimelineEntries", () => ({
  useIncrementalTimelineEntries: () => timeline.entries,
}));

vi.mock("../../state/entities", () => ({
  useTimelineVisibleTurnItems: () => [],
}));

vi.mock("../ChatView.logic", () => ({
  peekRememberedThreadTimeline: () => null,
  rememberReadyThreadTimeline: () => {},
  resolveThreadSwitchTimeline: ({ nextEntries }: { nextEntries: unknown }) => nextEntries,
  timelineHasEphemeralPreviewUrls: () => false,
}));

vi.mock("./MessagesTimeline", () => ({
  MessagesTimeline: (props: {
    readonly timelineEntries: ReadonlyArray<{ readonly id: string; readonly kind: string }>;
  }) => {
    timeline.rendered = props.timelineEntries;
    return <div data-testid="timeline">{props.timelineEntries.length}</div>;
  },
}));

const entries = [
  { id: "user-1", kind: "message" },
  { id: "work-1", kind: "work" },
  { id: "assistant-1", kind: "message" },
  { id: "user-2", kind: "message" },
  { id: "assistant-2", kind: "message" },
];

function propsFor(timelineDensity: string) {
  return {
    threadDetailRef: null,
    entriesInput: {},
    draftEntries: null,
    activeThreadKey: "env-1:thread-a",
    syncing: false,
    detailLoading: false,
    timelineDensity,
  } as unknown as ComponentProps<typeof ThreadTimeline>;
}

describe("ThreadTimeline pane density", () => {
  it.each(["glance", "compact"])(
    "keeps the full history in a %s pane so the timeline stays scrollable",
    async (density) => {
      timeline.entries = entries;
      timeline.rendered = [];
      await using _screen = await render(<ThreadTimeline {...propsFor(density)} />);

      expect(timeline.rendered.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
    },
  );
});

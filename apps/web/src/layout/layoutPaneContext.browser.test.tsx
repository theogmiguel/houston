import { useEffect, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import { BackgroundThreadContext } from "../components/chat/backgroundThread";
import {
  LayoutPaneContext,
  LONE_PANE,
  useLayoutPane,
  useLayoutPaneFocusedRef,
  useLayoutPaneOwnsThreadRef,
  type LayoutPaneState,
} from "./layoutPaneContext";

function Probe(props: { readonly onRefs: (focused: boolean, owns: boolean) => void }) {
  const pane = useLayoutPane();
  const focusedRef = useLayoutPaneFocusedRef();
  const ownsRef = useLayoutPaneOwnsThreadRef();
  const { onRefs } = props;
  useEffect(() => {
    onRefs(focusedRef.current, ownsRef.current);
  }, [focusedRef, ownsRef, onRefs]);
  return <output data-testid="pane">{`${pane.focused}:${pane.visible}`}</output>;
}

async function readRefs(wrap: (children: ReactNode) => ReactNode) {
  const seen: Array<[boolean, boolean]> = [];
  const view = await render(
    wrap(<Probe onRefs={(focused, owns) => void seen.push([focused, owns])} />),
  );
  return {
    last: () => seen.at(-1)!,
    [Symbol.asyncDispose]: () => view[Symbol.asyncDispose](),
  };
}

const pane = (patch: Partial<LayoutPaneState>): LayoutPaneState => ({ ...LONE_PANE, ...patch });

describe("layout pane context", () => {
  it("is one focused, visible view outside a layout host", async () => {
    await using view = await render(<Probe onRefs={() => {}} />);
    await expect.element(view.getByTestId("pane")).toHaveTextContent("true:true");
  });

  it("owns the keyboard only while focused, or while related, and never in the background", async () => {
    await using focused = await readRefs((children) => (
      <LayoutPaneContext value={pane({ focused: true })}>{children}</LayoutPaneContext>
    ));
    await expect.poll(() => focused.last()).toEqual([true, true]);

    await using unfocused = await readRefs((children) => (
      <LayoutPaneContext value={pane({ focused: false })}>{children}</LayoutPaneContext>
    ));
    await expect.poll(() => unfocused.last()).toEqual([false, false]);

    await using related = await readRefs((children) => (
      <LayoutPaneContext value={pane({ focused: false, related: true })}>
        {children}
      </LayoutPaneContext>
    ));
    await expect.poll(() => related.last()).toEqual([false, true]);

    await using background = await readRefs((children) => (
      <BackgroundThreadContext value>
        <LayoutPaneContext value={pane({ focused: true })}>{children}</LayoutPaneContext>
      </BackgroundThreadContext>
    ));
    await expect.poll(() => background.last()).toEqual([false, false]);
  });
});

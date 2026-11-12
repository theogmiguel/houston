import type { ReactNode } from "react";

import { LayoutEmptyBody } from "../components/ui/layout-pane";

/** A pane whose active tab is gone: it says so instead of drawing a blank surface. */
export function LayoutEmptyPane({ children }: { children?: ReactNode }) {
  return (
    <LayoutEmptyBody data-layout-empty-pane="">
      <p>Nothing open in this pane.</p>
      {children}
    </LayoutEmptyBody>
  );
}

/**
 * The frame of a launcher tab, and of an empty workspace: `children` is the launcher itself
 * (its project picker belongs to whoever mounts the layout) and `footer` a hint under it.
 */
export function LayoutLauncherShell({
  tabId,
  children,
  footer,
}: {
  /** The launcher tab's id; null for an empty workspace, which has no tab. */
  tabId: string | null;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <LayoutEmptyBody data-layout-launcher={tabId ?? ""}>
      {children}
      {footer}
    </LayoutEmptyBody>
  );
}

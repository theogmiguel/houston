import type { ReactNode } from "react";

/** A quiet inline explanation for a control the host does not support. */
export function ReadOnlyNotice({ children }: { readonly children: ReactNode }) {
  return (
    <p className="mb-2 rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
      {children}
    </p>
  );
}

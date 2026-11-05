import type { ReactNode } from "react";

/** A quiet note at the top of the diff list about what the current patch leaves out. */
export function DiffNotice({ children }: { readonly children: ReactNode }) {
  return (
    <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
      {children}
    </p>
  );
}

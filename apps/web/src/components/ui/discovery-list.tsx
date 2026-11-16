import type { ComponentProps, ReactNode } from "react";

export function DiscoveryList({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-[var(--r-group)] border border-border/70 bg-card">
      {children}
    </div>
  );
}

/** The heading and one line of help that open a picker of places to go. */
export function DiscoveryIntro({
  title,
  children,
}: {
  readonly title: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 px-1">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  );
}

export function DiscoveryListRow({
  icon,
  title,
  description,
  action,
  ...props
}: Omit<ComponentProps<"button">, "title" | "children" | "className"> & {
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <button
      type="button"
      {...props}
      className="group flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-hover/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64"
    >
      {icon}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        <span className="truncate text-xs text-muted-foreground">{description}</span>
      </div>
      {action}
    </button>
  );
}

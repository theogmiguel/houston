import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";

export function SettingsGroup({
  variant = "grouped",
  divided = true,
  className,
  ...props
}: ComponentProps<"div"> & {
  variant?: "grouped" | "plain";
  divided?: boolean;
}) {
  return (
    <div
      data-slot="settings-group"
      {...props}
      className={cn(
        "relative text-foreground",
        variant === "grouped"
          ? "overflow-hidden rounded-lg border border-border bg-card"
          : "space-y-1",
        variant === "grouped" &&
          divided &&
          "[&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:top-0 [&>*+*]:before:left-3.5 [&>*+*]:before:right-0 [&>*+*]:before:h-px [&>*+*]:before:bg-border [&>*+*]:before:content-['']",
        className,
      )}
    />
  );
}

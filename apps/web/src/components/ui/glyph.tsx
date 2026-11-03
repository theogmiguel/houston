import type { LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";

const TONE_CLASS = {
  muted: "text-muted-foreground",
  warning: "text-(--warn-ink)",
  danger: "text-error-foreground",
} as const;

/** A decorative icon with the ink role kept out of feature code. Size it through `className`. */
export function Glyph({
  icon: Icon,
  tone = "muted",
  className,
}: {
  readonly icon: LucideIcon;
  readonly tone?: keyof typeof TONE_CLASS;
  readonly className?: string;
}) {
  return <Icon aria-hidden className={cn("shrink-0", TONE_CLASS[tone], className)} />;
}

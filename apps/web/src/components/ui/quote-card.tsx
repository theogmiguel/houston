import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type * as React from "react";

import { cn } from "~/lib/utils";

/** The block a quote card and its comment sit in. It adds no margin at the start or end of its parent. */
function QuoteCardBlock({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="quote-card-block"
      className={cn("my-1.5 block first:mt-0 last:mb-0", className)}
      {...props}
    />
  );
}

/**
 * An inset card for a quote inside a message bubble. Render it as the link to the quoted source:
 * the message's markdown colours and underlines links, and a card is neither.
 */
function QuoteCard({ className, render, ...props }: useRender.ComponentProps<"a">) {
  const defaultProps = {
    "data-slot": "quote-card",
    className: cn(
      "block min-w-0 rounded-lg bg-foreground/6 px-2.5 py-1.5 text-start text-sm text-muted-foreground! no-underline! wrap-anywhere transition-colors duration-(--motion-feedback) ease-standard hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring",
      className,
    ),
  };
  return useRender({ defaultTagName: "a", props: mergeProps<"a">(defaultProps, props), render });
}

/** The quoted text, clamped to three lines. Keep the line count in step with `QUOTE_CARD_LINES`. */
function QuoteCardText({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="quote-card-text" className={cn("line-clamp-3", className)} {...props} />;
}

/** What the user wrote about the quote, under its card. */
function QuoteCardComment({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="quote-card-comment"
      className={cn("mt-1.5 block whitespace-pre-wrap", className)}
      {...props}
    />
  );
}

export { QuoteCard, QuoteCardBlock, QuoteCardComment, QuoteCardText };

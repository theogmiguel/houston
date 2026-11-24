import type { AssistantCitation } from "@houston-app/contracts";
import {
  assistantCitationLabel,
  serializeAssistantCitation,
} from "@houston-app/shared/assistantCitations";
import { Link, useNavigate } from "@tanstack/react-router";
import { QuoteIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  findAssistantCitationSourceAnchor,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import { isSelectionRectVisible } from "~/lib/selectionActions";
import {
  assistantCitationHash,
  assistantCitationNavigation,
} from "../../lib/assistantCitationNavigation";
import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { Popover, PopoverPopup } from "../ui/popover";
import { QuoteCard, QuoteCardBlock, QuoteCardComment, QuoteCardText } from "../ui/quote-card";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import { resolveAssistantCitationCommentDismissal } from "./assistantCitationCommentDismissal";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";
import { textDirection } from "~/textDirection";

const WHITESPACE_RUN = /\s+/g;
const flat = (text: string) => text.replace(WHITESPACE_RUN, " ");

/**
 * A quoted response inside a sent message: an inset card with the quote clamped to three lines,
 * and the full response one click away at its source. The quote renders as plain text, so
 * markdown and markup in it stay literal. Its comment, when it has one, follows as text.
 */
export function AssistantCitationCard({ citation }: { citation: AssistantCitation }) {
  const navigate = useNavigate();
  const { comment, ...quoted } = citation;
  return (
    // One copy boundary for the card and its comment, so a copied quote carries the comment once.
    <QuoteCardBlock data-markdown-copy={serializeAssistantCitation(citation)}>
      <QuoteCard
        render={
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId: citation.environmentId, threadId: citation.threadId }}
            hash={assistantCitationHash(citation)}
            resetScroll={false}
          />
        }
        data-assistant-citation-card=""
        // A selection inside the card copies the quote here and the comment as text.
        data-markdown-copy={serializeAssistantCitation(quoted)}
        // The quote is findable in its source message; here it is clamped.
        data-thread-find-ignore=""
        aria-label={`Go to quoted response: ${assistantCitationLabel(quoted)}`}
        onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          event.preventDefault();
          void navigate(assistantCitationNavigation(citation));
        }}
      >
        <QuoteCardText data-assistant-citation-quote="" dir={textDirection(citation.text)}>
          {flat(citation.text)}
        </QuoteCardText>
      </QuoteCard>
      {comment ? <QuoteCardComment dir={textDirection(comment)}>{comment}</QuoteCardComment> : null}
    </QuoteCardBlock>
  );
}

/** The quote chip in the composer, with its comment editor. */
export function AssistantCitationChip({
  citation,
  onRemove,
  commentEditor,
}: {
  citation: AssistantCitation;
  onRemove?: () => void;
  commentEditor?: {
    open: boolean;
    sourceAnchor?: AssistantCitationSourceAnchor | undefined;
    onOpenChange: (open: boolean) => void;
    onCancel?: () => void;
    onSave: (comment: string) => boolean;
    onSaveAndSend?: (comment: string) => boolean;
    onDraftChange?: (comment: string) => void;
    onRestoreFocus?: () => void;
  };
}) {
  const navigate = useNavigate();
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const chipRef = useRef<HTMLSpanElement>(null);
  const draftCommentRef = useRef<string | null>(null);
  const [unavailableSourceAnchor, setUnavailableSourceAnchor] =
    useState<AssistantCitationSourceAnchor | null>(null);
  const commentOpen = commentEditor?.open ?? false;
  const sourceAnchor = commentEditor?.sourceAnchor;
  const activeSourceAnchor = sourceAnchor === unavailableSourceAnchor ? undefined : sourceAnchor;
  const fallbackSourceAnchor =
    commentOpen && !activeSourceAnchor
      ? findAssistantCitationSourceAnchor(document, citation)
      : null;
  const editorAnchor = activeSourceAnchor ?? fallbackSourceAnchor ?? undefined;
  // The range positions the popover and the source gives it the scroll ancestors that track. A
  // comment opened without a source anchors to the composer chip instead.
  const resolvePopoverAnchor = () => {
    if (!editorAnchor) return chipRef.current;
    return {
      getBoundingClientRect: () => editorAnchor.range.getBoundingClientRect(),
      contextElement: editorAnchor.source,
    };
  };
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- drops the uncommitted comment draft held in a ref once the parent closes the comment editor
  useEffect(() => {
    if (!commentOpen) draftCommentRef.current = null;
  }, [commentOpen]);
  const settleDraftOnClose = (reason: string): boolean => {
    const dismissal = resolveAssistantCitationCommentDismissal({
      reason,
      draft: draftCommentRef.current,
      savedComment: citation.comment,
    });
    if (dismissal.kind === "commit") return commentEditor?.onSave(dismissal.comment) ?? true;
    return dismissal.kind !== "keep-open";
  };
  const onSourceUnavailable = useEffectEvent(() => {
    if (!sourceAnchor) return;
    if (settleDraftOnClose("none")) {
      commentEditor?.onOpenChange(false);
    } else {
      setUnavailableSourceAnchor(sourceAnchor);
    }
  });
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- observes the cited DOM source while the comment editor is open and reacts when it disappears
  useEffect(() => {
    if (!commentOpen || sourceAnchor === unavailableSourceAnchor) return;
    const anchor = sourceAnchor ?? findAssistantCitationSourceAnchor(document, citation);
    if (!anchor) return;
    return observeAssistantCitationCommentSource({
      anchor,
      citation,
      onUnavailable: onSourceUnavailable,
    });
  }, [citation, commentOpen, sourceAnchor, unavailableSourceAnchor]);
  const onScrollAway = useEffectEvent(() => {
    if (settleDraftOnClose("scroll-out")) {
      commentEditor?.onOpenChange(false);
    }
  });
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- tracks the cited range in the thread viewport and dismisses the editor once it scrolls out
  useEffect(() => {
    if (!commentOpen || !editorAnchor) return;
    const { range, viewport } = editorAnchor;
    let frame: number | null = null;
    const check = () => {
      frame = null;
      const visible = isSelectionRectVisible(range.getBoundingClientRect(), [
        viewport.getBoundingClientRect(),
      ]);
      if (!visible) onScrollAway();
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(check);
    };
    viewport.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [commentOpen, editorAnchor]);
  const label = assistantCitationLabel(citation);
  const sourceLinkProps = {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId: citation.environmentId, threadId: citation.threadId },
    hash: assistantCitationHash(citation),
    "data-markdown-copy": serializeAssistantCitation(citation),
    resetScroll: false,
    onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      void navigate(assistantCitationNavigation(citation));
    },
  };
  const composerSourceLink = (
    <Link
      {...sourceLinkProps}
      className="inline-flex min-w-0 items-center gap-[0.2em] self-baseline text-inherit no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current rounded-sm"
      aria-label={`View cited assistant text: ${label}`}
    >
      <QuoteIcon aria-hidden="true" />
      <ContextChipLabel className="max-w-[16em]" dir={textDirection(label)}>
        {label}
      </ContextChipLabel>
    </Link>
  );
  return (
    <ContextChip
      ref={chipRef}
      kind="citation"
      contentEditable={false}
      data-assistant-citation-chip="true"
      data-markdown-copy={serializeAssistantCitation(citation)}
    >
      {composerSourceLink}
      {commentEditor && commentOpen ? (
        <Popover
          open
          onOpenChange={(open, details) => {
            if (open) return;
            if (!settleDraftOnClose(details.reason)) return;
            commentEditor.onOpenChange(false);
          }}
        >
          <PopoverPopup
            anchor={resolvePopoverAnchor}
            side="bottom"
            width="md"
            padding="none"
            aria-label="Edit citation comment"
            initialFocus={commentInputRef}
            finalFocus={false}
          >
            <AssistantCitationCommentEditor
              key={serializeAssistantCitation(citation)}
              citation={citation}
              inputRef={commentInputRef}
              onDraftChange={(comment) => {
                draftCommentRef.current = comment;
                commentEditor.onDraftChange?.(comment);
              }}
              onSubmit={(comment) => {
                if (!commentEditor.onSave(comment)) return false;
                commentEditor.onOpenChange(false);
                commentEditor.onRestoreFocus?.();
                return true;
              }}
              {...(commentEditor.onSaveAndSend
                ? {
                    onSubmitAndSend: (comment: string) => {
                      if (!commentEditor.onSaveAndSend?.(comment)) return false;
                      commentEditor.onOpenChange(false);
                      return true;
                    },
                  }
                : {})}
              onCancel={() => {
                if (commentEditor.onCancel) {
                  commentEditor.onCancel();
                } else {
                  commentEditor.onOpenChange(false);
                }
              }}
            />
          </PopoverPopup>
        </Popover>
      ) : null}
      {onRemove ? (
        <ContextChipAction
          aria-label="Remove citation"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onRemove}
        >
          <XIcon aria-hidden="true" />
        </ContextChipAction>
      ) : null}
    </ContextChip>
  );
}

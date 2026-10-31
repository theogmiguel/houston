import type { AssistantCitation, PreviewAnnotationPayload } from "@t3tools/contracts";
import { ImageIcon, QuoteIcon, XIcon } from "lucide-react";

export type PendingCitationChip = {
  citation: AssistantCitation;
  promptStart: number;
  promptEnd: number;
};

export type PendingPreviewAnnotationChip = {
  annotation: PreviewAnnotationPayload;
  promptStart: number;
  promptEnd: number;
};

const QUOTE_PREVIEW_CHARS = 38;

export function citationChipLabel(citation: AssistantCitation): string {
  const quote = citation.text.replace(/\s+/g, " ").trim();
  const preview =
    quote.length > QUOTE_PREVIEW_CHARS ? `${quote.slice(0, QUOTE_PREVIEW_CHARS)}…` : quote;
  return `“${preview}”${citation.comment ? ` · ${citation.comment}` : ""}`;
}

export function previewAnnotationChipLabel(annotation: PreviewAnnotationPayload): string {
  const element = annotation.elements[0]?.element;
  const target =
    element?.componentName ||
    element?.selector ||
    element?.tagName ||
    (annotation.regions.length > 0
      ? `${annotation.regions.length} region${annotation.regions.length === 1 ? "" : "s"}`
      : annotation.pageTitle?.trim() || null);
  return ["Preview", target, annotation.comment.trim()].filter(Boolean).join(" · ");
}

/**
 * Pending annotations collected above the composer: assistant citations and preview
 * annotations travel with the prompt as records, but read as removable chips here.
 */
export function ComposerPendingAnnotationChips(props: {
  citations: ReadonlyArray<PendingCitationChip>;
  previewAnnotations: ReadonlyArray<PendingPreviewAnnotationChip>;
  onEditCitation: (chip: PendingCitationChip) => void;
  onRemoveCitation: (chip: PendingCitationChip) => void;
  onRemovePreviewAnnotation: (chip: PendingPreviewAnnotationChip) => void;
}) {
  if (props.citations.length === 0 && props.previewAnnotations.length === 0) return null;
  return (
    <div data-composer-pending-annotations="true" className="flex flex-wrap gap-1.5 px-0.5 pb-2">
      {props.citations.map((chip) => {
        const label = citationChipLabel(chip.citation);
        return (
          <span
            key={`citation:${chip.citation.messageId}:${chip.citation.start}:${chip.promptStart}`}
            data-annotation-chip="citation"
            className="inline-flex h-6 max-w-[300px] items-center gap-1.5 rounded-(--r-ctl) border border-(--border) bg-(--field) ps-2 pe-0.5 text-xs text-(--t2)"
          >
            <QuoteIcon aria-hidden="true" className="size-3 shrink-0 text-(--t3)" />
            <button
              type="button"
              aria-label={`Edit citation comment: ${label}`}
              className="min-w-0 cursor-pointer truncate text-left text-(--t1) outline-none focus-visible:underline"
              onClick={() => props.onEditCitation(chip)}
            >
              {label}
            </button>
            <button
              type="button"
              aria-label="Remove citation"
              className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-(--r-badge) text-(--t3) outline-none hover:bg-(--hover) hover:text-(--t1) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={() => props.onRemoveCitation(chip)}
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          </span>
        );
      })}
      {props.previewAnnotations.map((chip) => {
        const label = previewAnnotationChipLabel(chip.annotation);
        return (
          <span
            key={`preview:${chip.annotation.id}:${chip.promptStart}`}
            data-annotation-chip="preview"
            className="inline-flex h-6 max-w-[300px] items-center gap-1.5 rounded-(--r-ctl) border border-(--border) bg-(--field) ps-2 pe-0.5 text-xs text-(--t2)"
          >
            <ImageIcon aria-hidden="true" className="size-3 shrink-0 text-(--t3)" />
            <span className="min-w-0 truncate text-(--t1)">{label}</span>
            <button
              type="button"
              aria-label="Remove preview annotation"
              className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-(--r-badge) text-(--t3) outline-none hover:bg-(--hover) hover:text-(--t1) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={() => props.onRemovePreviewAnnotation(chip)}
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

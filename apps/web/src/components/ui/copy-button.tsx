import { Check, Copy } from "lucide";
import { useRef } from "react";

import { MorphIcon } from "~/components/MorphIcon";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";

import { showAnchoredCopyErrorToast } from "./anchoredCopyToast";
import { Button, type ButtonSize, type ButtonVariant } from "./button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

interface CopyButtonOptions {
  target?: string;
  timeout?: number;
  extraFlavors?: Readonly<Record<string, string>>;
  onCopy?: () => void;
  onError?: (error: Error) => void;
}

/**
 * The clipboard behaviour behind every copy control: writes the text, keeps the
 * copied state for `timeout`, reports failures, and exposes the trigger ref for
 * an anchored error toast. Render it with `CopyButton` unless the control needs
 * a layout the button cannot express, such as a code line.
 */
export function useCopyButton({
  target,
  timeout = 2000,
  extraFlavors,
  onCopy,
  onError,
}: CopyButtonOptions = {}) {
  const ref = useRef<HTMLButtonElement>(null);
  const reportError = useStableCallback((error: Error) => {
    if (onError) onError(error);
    else showAnchoredCopyErrorToast(ref, error);
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    ...(target ? { target } : {}),
    timeout,
    ...(extraFlavors ? { extraFlavors } : {}),
    ...(onCopy ? { onCopy } : {}),
    onError: reportError,
  });

  return { copied: isCopied, copy: copyToClipboard, ref, reportError };
}

type CopyButtonValue =
  | { readonly value: string; readonly getValue?: undefined }
  | { readonly value?: undefined; readonly getValue: () => Promise<string> };

export function CopyButton({
  value,
  getValue,
  label,
  copiedLabel = "Copied",
  ariaLabel,
  icon = Copy,
  size = "icon-sm",
  variant = "ghost-muted",
  className,
  iconClassName,
  showLabel = false,
  disabled = false,
  target,
  timeout,
  extraFlavors,
  onCopy,
  onError,
}: CopyButtonValue & {
  /** Accessible name and the idle tooltip. */
  label: string;
  /** Announced and shown once the text is on the clipboard. */
  copiedLabel?: string;
  ariaLabel?: string;
  icon?: typeof Copy;
  size?: ButtonSize;
  variant?: ButtonVariant;
  className?: string;
  iconClassName?: string;
  showLabel?: boolean;
  disabled?: boolean;
  target?: string;
  timeout?: number;
  extraFlavors?: Readonly<Record<string, string>>;
  onCopy?: () => void;
  onError?: (error: Error) => void;
}) {
  const { copied, copy, ref, reportError } = useCopyButton({
    ...(target ? { target } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(extraFlavors ? { extraFlavors } : {}),
    ...(onCopy ? { onCopy } : {}),
    ...(onError ? { onError } : {}),
  });

  const handleClick = () => {
    if (getValue) {
      void getValue().then(copy, (cause) =>
        reportError(cause instanceof Error ? cause : new Error(String(cause))),
      );
      return;
    }
    copy(value);
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={ariaLabel ?? label}
              className={className}
              data-slot="copy-button"
              disabled={disabled}
              onClick={handleClick}
              ref={ref}
              size={size}
              type="button"
              variant={variant}
            />
          }
        >
          <MorphIcon
            className={cn(iconClassName, copied && "text-success-foreground")}
            icon={copied ? Check : icon}
          />
          {showLabel ? <span>{copied ? copiedLabel : label}</span> : null}
        </TooltipTrigger>
        <TooltipPopup>
          <p>{copied ? "Copied" : label}</p>
        </TooltipPopup>
      </Tooltip>
      <span aria-live="polite" className="sr-only" role="status">
        {copied ? copiedLabel : ""}
      </span>
    </>
  );
}

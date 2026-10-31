import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ArrowUpIcon, CircleArrowUpIcon } from "lucide-react";
import type { AnimationEventHandler } from "react";

const DOWNLOAD_PROGRESS_RADIUS = 6;
const DOWNLOAD_PROGRESS_CIRCUMFERENCE = 2 * Math.PI * DOWNLOAD_PROGRESS_RADIUS;

export type DesktopUpdateStatusIconState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "everything";

function normalizeDesktopUpdateDownloadPercent(percent: number | null): number {
  if (percent === null || !Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

export function shouldShowDesktopUpdateCheckIcon({
  isAnimationLatched,
  isChecking,
  prefersReducedMotion,
}: {
  readonly isAnimationLatched: boolean;
  readonly isChecking: boolean;
  readonly prefersReducedMotion: boolean;
}): boolean {
  return isChecking || (isAnimationLatched && !prefersReducedMotion);
}

export function shouldContinueDesktopUpdateCheckAnimation({
  isChecking,
  prefersReducedMotion,
}: {
  readonly isChecking: boolean;
  readonly prefersReducedMotion: boolean;
}): boolean {
  return isChecking && !prefersReducedMotion;
}

function DesktopUpdateAvailableIcon() {
  return <ArrowUpIcon className="size-3.5" strokeWidth={1.7} />;
}

function DesktopUpdateDownloadingIcon({ percent }: { readonly percent: number | null }) {
  const normalizedPercent = normalizeDesktopUpdateDownloadPercent(percent);
  const progressOffset = DOWNLOAD_PROGRESS_CIRCUMFERENCE * (1 - normalizedPercent / 100);

  return (
    <svg aria-hidden="true" className="size-3.5 -rotate-90" viewBox="0 0 16 16">
      <circle
        cx="8"
        cy="8"
        r={DOWNLOAD_PROGRESS_RADIUS}
        fill="none"
        className="stroke-current/25"
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        r={DOWNLOAD_PROGRESS_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeDasharray={DOWNLOAD_PROGRESS_CIRCUMFERENCE}
        strokeDashoffset={progressOffset}
        strokeWidth="2"
        className="transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
      />
    </svg>
  );
}

function DesktopUpdateDownloadedIcon() {
  return <span className="mx-1 size-1.5 shrink-0 rounded-full bg-current" />;
}

export function DesktopUpdateStatusIcon({
  downloadPercent,
  isCheckAnimating,
  onCheckAnimationIteration,
  status,
}: {
  readonly downloadPercent?: number | null;
  readonly isCheckAnimating?: boolean;
  readonly onCheckAnimationIteration?: AnimationEventHandler<SVGSVGElement>;
  readonly status: DesktopUpdateStatusIconState;
}) {
  if (status === "available") return <DesktopUpdateAvailableIcon />;
  if (status === "downloading") {
    return <DesktopUpdateDownloadingIcon percent={downloadPercent ?? null} />;
  }
  if (status === "downloaded") return <DesktopUpdateDownloadedIcon />;
  if (status === "everything") return <CircleArrowUpIcon className="size-3.5" strokeWidth={1.7} />;

  return (
    <RefreshIcon
      className="size-3.5"
      refreshing={status === "checking" && isCheckAnimating === true}
      onAnimationIteration={onCheckAnimationIteration}
    />
  );
}

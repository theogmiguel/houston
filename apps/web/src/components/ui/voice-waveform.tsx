import { useEffect, useRef, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { Text } from "./text";

const WAVEFORM_BAR_COUNT = 28;
const WAVEFORM_BAR_IDS = Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) => String(index));

/** Microphone levels, newest at the right, with opacity and height carrying the level. */
export function VoiceWaveform(props: { level: number }) {
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const levelsRef = useRef(Array<number>(WAVEFORM_BAR_COUNT).fill(0));

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Publish microphone samples to the waveform DOM after React commits.
  useEffect(() => {
    const levels = levelsRef.current;
    levels.copyWithin(0, 1);
    levels[levels.length - 1] = props.level;
    barsRef.current.forEach((bar, index) => {
      if (!bar) return;
      const level = levels[index] ?? 0;
      bar.style.opacity = String(0.22 + level * 0.78);
      bar.style.transform = `scaleY(${prefersReducedMotion ? 0.35 : Math.max(0.08, level)})`;
    });
  }, [prefersReducedMotion, props.level]);

  return (
    <div
      aria-hidden
      className="flex h-5 min-w-0 flex-1 items-center justify-between gap-px overflow-hidden"
    >
      {WAVEFORM_BAR_IDS.map((id, index) => (
        <span
          key={id}
          ref={(bar) => {
            barsRef.current[index] = bar;
          }}
          className="h-full w-0.5 shrink-0 origin-center rounded-full bg-primary opacity-25 transition-[transform,opacity] duration-100 ease-out motion-reduce:transition-none"
          style={{ transform: `scaleY(${prefersReducedMotion ? 0.35 : 0.08})` }}
        />
      ))}
    </div>
  );
}

/** The waveform, a live dot and the recording clock. */
export function RecordingStatus(props: { level: number }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Run the elapsed recording clock only while the recording status is mounted.
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000)),
      250,
    );
    return () => window.clearInterval(timer);
  }, []);

  const minutes = Math.floor(elapsedSeconds / 60);
  return (
    <>
      <VoiceWaveform level={props.level} />
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
      <Text as="span" variant="caption" tone="muted" tabular className="shrink-0">
        {minutes}:{String(elapsedSeconds % 60).padStart(2, "0")}
      </Text>
    </>
  );
}

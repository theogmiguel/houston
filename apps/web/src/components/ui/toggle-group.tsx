import type { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { Toggle as ToggleComponent, type toggleVariants } from "~/components/ui/toggle";

const ToggleGroupContext = React.createContext<VariantProps<typeof toggleVariants>>({
  size: "default",
  variant: "default",
});

function ToggleGroup({
  className,
  variant = "segmented",
  size: sizeProp,
  orientation = "horizontal",
  children,
  onValueChange,
  ...props
}: ToggleGroupPrimitive.Props & VariantProps<typeof toggleVariants>) {
  const size =
    sizeProp === undefined ? (variant === "segmented" ? "segmented" : "default") : sizeProp;
  const value = { size, variant };
  const segmented = variant === "segmented";
  const groupRef = React.useRef<HTMLDivElement>(null);
  const indicatorRef = React.useRef<HTMLSpanElement>(null);
  // Re-renders after an uncontrolled toggle so the indicator is measured from the committed DOM.
  const [, setRevision] = React.useState(0);

  const placeIndicator = useStableCallback(() => {
    const group = groupRef.current;
    const indicator = indicatorRef.current;
    if (group === null || indicator === null) return;
    const pressed = group.querySelector<HTMLElement>("[data-pressed]");
    if (pressed === null) {
      indicator.style.opacity = "0";
      return;
    }
    const groupRect = group.getBoundingClientRect();
    const pressedRect = pressed.getBoundingClientRect();
    indicator.style.width = `${pressedRect.width}px`;
    indicator.style.height = `${pressedRect.height}px`;
    indicator.style.transform = `translate(${pressedRect.left - groupRect.left}px, ${pressedRect.top - groupRect.top}px)`;
    indicator.style.opacity = "1";
  });

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- writes the pressed toggle's box onto the indicator before paint
  React.useLayoutEffect(() => {
    if (segmented) placeIndicator();
  });

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- keeps the indicator aligned with the group outside React
  React.useEffect(() => {
    if (!segmented || groupRef.current === null) return;
    return observeResize(groupRef.current, placeIndicator);
  }, [segmented, placeIndicator]);

  const handleValueChange: ToggleGroupPrimitive.Props["onValueChange"] = (next, details) => {
    onValueChange?.(next, details);
    if (segmented) setRevision((revision) => revision + 1);
  };

  return (
    <ToggleGroupPrimitive
      {...props}
      ref={groupRef}
      className={cn(
        "flex w-fit *:focus-visible:z-10 dark:*:[[data-slot=separator]:has(+[data-slot=toggle]:hover)]:before:bg-input/64 dark:*:[[data-slot=separator]:has(+[data-slot=toggle][data-pressed])]:before:bg-input dark:*:[[data-slot=toggle]:hover+[data-slot=separator]]:before:bg-input/64 dark:*:[[data-slot=toggle][data-pressed]+[data-slot=separator]]:before:bg-input",
        orientation === "horizontal"
          ? "*:pointer-coarse:after:min-w-auto"
          : "*:pointer-coarse:after:min-h-auto",
        variant === "segmented"
          ? "relative gap-0.5 rounded-[var(--r-ctl)] bg-[var(--field)] p-0.5"
          : variant === "default"
            ? "gap-0.5"
            : orientation === "horizontal"
              ? "*:not-first:not-data-[slot=separator]:before:-start-[0.5px] *:not-last:not-data-[slot=separator]:before:-end-[0.5px] *:not-first:rounded-s-none *:not-last:rounded-e-none *:not-first:border-s-0 *:not-last:border-e-0 *:not-first:before:rounded-s-none *:not-last:before:rounded-e-none"
              : "*:not-first:not-data-[slot=separator]:before:-top-[0.5px] *:not-last:not-data-[slot=separator]:before:-bottom-[0.5px] flex-col *:not-first:rounded-t-none *:not-last:rounded-b-none *:not-first:border-t-0 *:not-last:border-b-0 *:not-first:before:rounded-t-none *:not-last:before:rounded-b-none *:data-[slot=toggle]:not-last:before:hidden dark:*:last:before:hidden dark:*:first:before:block",
        className,
      )}
      data-size={size}
      data-slot="toggle-group"
      data-variant={variant}
      orientation={orientation}
      onValueChange={handleValueChange}
    >
      {segmented ? (
        <span
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 rounded-[var(--r-badge)] bg-[var(--surface-raised)] opacity-0 shadow-[var(--shadow-seg)] transition-transform duration-(--motion-value) ease-standard"
          data-slot="toggle-group-indicator"
          ref={indicatorRef}
        />
      ) : null}
      <ToggleGroupContext value={value}>{children}</ToggleGroupContext>
    </ToggleGroupPrimitive>
  );
}

function Toggle({
  className,
  children,
  variant,
  size,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  const context = React.use(ToggleGroupContext);

  const resolvedVariant = variant ?? context.variant;
  const resolvedSize = size ?? context.size;

  return (
    <ToggleComponent
      className={className}
      data-size={resolvedSize}
      data-variant={resolvedVariant}
      size={resolvedSize}
      variant={resolvedVariant}
      {...props}
    >
      {children}
    </ToggleComponent>
  );
}

export { ToggleGroup, Toggle, Toggle as ToggleGroupItem };

import { MorphIcon as BaseMorphIcon, type MorphIconProps } from "morphicons/react";

// 2.5 matches the lucide default set in index.css; morphicons' svg lacks the `lucide` class that rule keys on.
export function MorphIcon({ reducedMotion = "user", strokeWidth = 2.5, ...props }: MorphIconProps) {
  return <BaseMorphIcon reducedMotion={reducedMotion} strokeWidth={strokeWidth} {...props} />;
}

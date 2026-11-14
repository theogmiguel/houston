import { useId } from "react";

import { checkThemeCss } from "../../themeCss";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DisclosureChevron } from "../ui/disclosure-chevron";
import { Text } from "../ui/text";
import { Textarea } from "../ui/textarea";

/** Why the CSS will not apply as typed, or null when it will. */
export function themeCssProblem(css: string): string | null {
  const check = checkThemeCss(css);
  switch (check.kind) {
    case "too-long":
      return `${check.length} of ${check.limit} characters. Shorten it to save.`;
    case "loads-files":
      return "Rules that load files are ignored. Only data: and #id addresses work.";
    case "backslash":
      return "Declarations that contain a backslash are ignored.";
    case "ok":
      return null;
  }
}

export function ThemeCssField({
  value,
  onChange,
  open,
  onOpenChange,
}: {
  value: string;
  onChange: (value: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const problemId = useId();
  const problem = themeCssProblem(value);
  const overLimit = checkThemeCss(value).kind === "too-long";
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
        <DisclosureChevron open={open} />
        Custom CSS
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="space-y-1.5 pt-1.5">
          <Textarea
            aria-describedby={problem === null ? undefined : problemId}
            aria-invalid={overLimit || undefined}
            aria-label="Custom CSS"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            font="mono"
            onChange={(event) => onChange(event.currentTarget.value)}
            placeholder="[data-chat-header] { border-bottom: 1px solid red; }"
            rows={6}
            spellCheck={false}
            value={value}
          />
          <Text
            aria-live="polite"
            as="p"
            id={problemId}
            tone={overLimit ? "danger" : "muted"}
            variant="caption"
          >
            {problem}
          </Text>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

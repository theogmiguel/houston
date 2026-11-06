import { useRouter } from "@tanstack/react-router";
import { Check, Copy } from "lucide";

import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { cn } from "../lib/utils";
import { MorphIcon } from "./MorphIcon";
import { Button } from "./ui/button";
import { RefreshIcon } from "./ui/refresh-icon";

/** The recovery buttons under a route error, at the standard control size. */
export function RouteErrorActions({ report }: { report: string }) {
  const router = useRouter();
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "error-report" });

  return (
    <div className="mt-5 flex flex-wrap gap-2">
      <Button onClick={() => void router.invalidate()}>
        <RefreshIcon />
        Try again
      </Button>
      <Button variant="secondary" onClick={() => window.location.reload()}>
        Reload app
      </Button>
      <Button variant="secondary" onClick={() => copyToClipboard(report)}>
        <MorphIcon className={cn(isCopied && "text-success")} icon={isCopied ? Check : Copy} />
        {isCopied ? "Copied" : "Copy error"}
      </Button>
    </div>
  );
}

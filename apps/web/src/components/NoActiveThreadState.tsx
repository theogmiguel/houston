import { useNavigate } from "@tanstack/react-router";
import { Check, Copy } from "lucide";

import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { cn } from "../lib/utils";
import { MorphIcon } from "./MorphIcon";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import {
  MISSING_THREAD_COPIED_ICON_CLS,
  MISSING_THREAD_ID_CLS,
  MISSING_THREAD_TITLE_CLS,
  NO_ACTIVE_THREAD_TITLE_CLS,
} from "./ui/missing-thread-recipes";
import { SERVER_UNAVAILABLE_CANVAS } from "./ui/server-unavailable-recipes";
import { SidebarInset } from "./ui/sidebar";
import { StandalonePageHeader } from "./ui/standalone-page";
import { isDesktopHost } from "../env";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

/**
 * The thread route has no thread to show. `missingThreadId` is set once the environment has
 * loaded and the id from the URL is not in it; before that the page offers the generic prompt.
 */
export function NoActiveThreadState({ missingThreadId }: { readonly missingThreadId?: string }) {
  const missing = missingThreadId !== undefined;
  return (
    <SidebarInset className="min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader desktop={isDesktopHost}>
          <span className={missing ? MISSING_THREAD_TITLE_CLS : NO_ACTIVE_THREAD_TITLE_CLS}>
            {missing ? "Thread not found" : "No active thread"}
          </span>
        </WorkspacePageHeader>

        {missing ? (
          <MissingThreadCard threadId={missingThreadId} />
        ) : (
          <Empty className="flex-1">
            <div className="w-full max-w-lg px-8 py-12">
              <EmptyHeader className="max-w-none">
                <EmptyTitle>Pick a thread to continue</EmptyTitle>
                <EmptyDescription>
                  Select an existing thread or create a new one to get started.
                </EmptyDescription>
              </EmptyHeader>
            </div>
          </Empty>
        )}
      </div>
    </SidebarInset>
  );
}

function MissingThreadCard({ threadId }: { readonly threadId: string }) {
  const navigate = useNavigate();
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "thread id" });
  return (
    <div data-missing-thread-canvas className={SERVER_UNAVAILABLE_CANVAS}>
      <section data-missing-thread-card className="mx-auto w-full max-w-(--chat-content-max-width)">
        <StandalonePageHeader
          showBrand={false}
          status="danger"
          title="This thread no longer exists"
          description={
            <>
              No thread with id <code className={MISSING_THREAD_ID_CLS}>{threadId}</code> is stored
              on this machine.
            </>
          }
        />
        <div className="mt-5 flex flex-wrap gap-2">
          <Button onClick={() => void navigate({ to: "/settings/archived" })}>Open archive</Button>
          <Button variant="secondary" onClick={() => void navigate({ to: "/" })}>
            New thread
          </Button>
          <Button variant="ghost" onClick={() => copyToClipboard(threadId)}>
            <MorphIcon
              className={cn(isCopied && MISSING_THREAD_COPIED_ICON_CLS)}
              icon={isCopied ? Check : Copy}
            />
            {isCopied ? "Copied" : "Copy ID"}
          </Button>
        </div>
      </section>
    </div>
  );
}

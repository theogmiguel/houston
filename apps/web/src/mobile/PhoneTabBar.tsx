import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChartNoAxesColumnIcon, MessageSquareIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";

import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../components/pullRequest/pullRequestListPreferences";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import {
  PHONE_TAB_BAR_CLS,
  PHONE_TAB_ROW_CLS,
  phoneTabClass,
  phoneTabLabelClass,
} from "../components/ui/phone-recipes";
import { useIsPhone } from "./usePhone";

export type PhoneTab = "threads" | "pull-requests" | "usage" | "settings";

const TABS: ReadonlyArray<{ id: PhoneTab; label: string; icon: ReactNode }> = [
  { id: "threads", label: "Threads", icon: <MessageSquareIcon aria-hidden className="size-5" /> },
  {
    id: "pull-requests",
    label: "Pull requests",
    icon: <PullRequestGlyph.pullRequest aria-hidden className="size-5" />,
  },
  {
    id: "usage",
    label: "Usage",
    icon: <ChartNoAxesColumnIcon aria-hidden className="size-5" />,
  },
  { id: "settings", label: "Settings", icon: <SettingsIcon aria-hidden className="size-5" /> },
];

/** The phone's four top-level destinations; nested settings pages stay under Settings. */
export function phoneTabForPathname(pathname: string): PhoneTab | null {
  if (pathname === "/") return "threads";
  if (pathname === "/pull-requests") return "pull-requests";
  if (pathname === "/usage") return "usage";
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  return null;
}

export function usePhoneTab(): PhoneTab | null {
  const isPhone = useIsPhone();
  const pathname = useLocation({ select: (location) => location.pathname });
  return isPhone ? phoneTabForPathname(pathname) : null;
}

/**
 * The phone's bottom navigation: one tab per top-level page, the current one in brand ink. A page
 * outside the four destinations (a missing workspace) names the tab it belongs to with `active`.
 */
export function PhoneTabBar({ active }: { active?: PhoneTab }) {
  const navigate = useNavigate();
  const routeTab = usePhoneTab();
  const activeTab = active ?? routeTab;
  if (activeTab === null) return null;
  const openTab = (tab: PhoneTab) => {
    if (tab === "threads") void navigate({ to: "/" });
    else if (tab === "pull-requests")
      void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
    else if (tab === "usage") void navigate({ to: "/usage" });
    else void navigate({ to: "/settings" });
  };

  return (
    <nav aria-label="Main" data-phone-tab-bar="" className={PHONE_TAB_BAR_CLS}>
      <div className={PHONE_TAB_ROW_CLS}>
        {TABS.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              aria-label={tab.label}
              aria-current={active ? "page" : undefined}
              onClick={() => openTab(tab.id)}
              className={phoneTabClass(active)}
            >
              {tab.icon}
              <span className={phoneTabLabelClass(active)}>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** The app shell on a phone page: the route content above the tab bar, which app-modal pages own. */
export function PhoneShell({ children }: { children: ReactNode }) {
  const tab = usePhoneTab();
  const appModal = useLocation({ select: (location) => isAppModalPage(location.pathname) });
  if (tab === null || appModal) return <>{children}</>;
  return (
    <div className="flex min-w-0 min-h-0 flex-1 flex-col">
      <div className="flex min-w-0 min-h-0 flex-1 flex-col">{children}</div>
      <PhoneTabBar />
    </div>
  );
}

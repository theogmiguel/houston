import { AndroidIcon, AppleIcon } from "../Icons";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// Houston has no published mobile apps yet; each store button says so instead of linking out.
const stores = [
  { label: "iPhone and iPad", store: "App Store", Icon: AppleIcon },
  { label: "Android", store: "Google Play", Icon: AndroidIcon },
];

export function MobileAppSettingsRow() {
  return (
    <SettingsRow
      {...searchableSetting("mobile-app")}
      description="Connect to your server from your phone or tablet."
      control={
        <div className="flex items-center gap-2">
          {stores.map(({ label, store, Icon }) => (
            <Popover key={store}>
              <PopoverTrigger render={<Button size="sm" variant="outline" />}>
                <Icon />
                {label}
              </PopoverTrigger>
              <PopoverPopup align="end">
                <div className="flex max-w-56 flex-col gap-1">
                  <PopoverTitle>Coming soon</PopoverTitle>
                  <p className="text-xs text-muted-foreground">
                    The Houston app for {label} is not on {store} yet.
                  </p>
                </div>
              </PopoverPopup>
            </Popover>
          ))}
        </div>
      }
    />
  );
}

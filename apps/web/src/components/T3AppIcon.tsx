// Houston's production app icon, whatever this build's channel.
import appIconUrl from "../assets/houston-app-icon.png";

export function T3AppIcon(props: { readonly className?: string }) {
  return <img src={appIconUrl} alt="" className={props.className} />;
}

import { useMediaQuery } from "../hooks/useMediaQuery";

/** Mirrors `--breakpoint-phone` in index.css. */
export const PHONE_QUERY = "(width < 40rem)";

export const useIsPhone = () => useMediaQuery(PHONE_QUERY);

/** The same test for event handlers, which cannot call the hook. */
export const isPhoneViewport = () => window.matchMedia(PHONE_QUERY).matches;

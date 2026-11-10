import { useMediaQuery } from "../hooks/useMediaQuery";

/** Mirrors `--breakpoint-phone` in index.css. */
export const PHONE_QUERY = "(width < 40rem)";

export const useIsPhone = () => useMediaQuery(PHONE_QUERY);

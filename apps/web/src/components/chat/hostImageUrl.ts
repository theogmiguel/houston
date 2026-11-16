import { createContext } from "react";

/** Where markdown loads an image file on the host by its absolute path, when the page has no environment to ask. */
export const HostImageUrlContext = createContext<((path: string) => string) | null>(null);

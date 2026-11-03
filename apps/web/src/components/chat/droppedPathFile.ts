import type { HostDroppedPath } from "@houston-app/contracts";

/** Wraps bytes the host read for a dropped path as the `File` the attachment intake expects. */
export function droppedPathToFile(entry: HostDroppedPath, path: string): File {
  if (entry.base64 === null) {
    throw new Error(
      `Dropped path ${JSON.stringify(path)} is a folder; expected a file with bytes to attach.`,
    );
  }
  let binary: string;
  try {
    binary = atob(entry.base64);
  } catch (cause) {
    throw new Error(
      `Dropped file ${JSON.stringify(path)} is not valid base64 (${entry.base64.length} characters, expected standard base64).`,
      { cause },
    );
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new File([bytes], entry.name || "dropped-file");
}

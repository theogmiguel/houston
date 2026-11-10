import { LazySurfaceBoundary, lazySurface } from "../LazySurface";
import { useInAnotherAppRequest } from "./useInAnotherAppRequest";

const UseInAnotherAppDialog = lazySurface(() =>
  import("./UseInAnotherAppDialog").then((module) => module.UseInAnotherAppDialog),
);

/** Hosted once at the root, so the command palette can open the wizard from anywhere. */
export function UseInAnotherAppDialogHost() {
  const open = useInAnotherAppRequest((state) => state.open);
  if (!open) return null;
  return (
    <LazySurfaceBoundary
      surface={UseInAnotherAppDialog}
      props={{}}
      label="MCP connection wizard"
      renderFrame={(content) => content}
    />
  );
}

import { lazy, Suspense, useEffect } from "react";
import { create } from "zustand";

import { preloadWhenIdle } from "../lib/preloadWhenIdle";
import { RenderErrorBoundary } from "./RenderErrorBoundary";

const loadForm = () => import("./CustomSnoozeDialogForm");
const CustomSnoozeDialogForm = lazy(() =>
  loadForm().then((module) => ({ default: module.CustomSnoozeDialogForm })),
);

export type CustomSnoozeChoice = { readonly snoozedUntil: string };
type Request = { readonly resolve: (choice: CustomSnoozeChoice | null) => void };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

export function requestCustomSnooze(): Promise<CustomSnoozeChoice | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { resolve } }));
}

function finish(choice: CustomSnoozeChoice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function CustomSnoozeDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- resolves any pending snooze request promise with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- an idle callback that fetches the form's chunk early; unmount cancels it.
  useEffect(() => preloadWhenIdle(loadForm), []);
  if (!request) return null;
  return (
    <RenderErrorBoundary fallback={null} resetKeys={[request]}>
      <Suspense fallback={null}>
        <CustomSnoozeDialogForm onFinish={finish} />
      </Suspense>
    </RenderErrorBoundary>
  );
}

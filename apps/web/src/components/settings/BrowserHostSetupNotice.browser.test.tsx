import { RegistryProvider } from "@effect/atom-react";
import { EnvironmentId } from "@houston-app/contracts";
import { previewStreamHostSetupMessage } from "@houston-app/client-runtime/preview/server-browser-stream";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  status: { blocked: true, setupCommand: "sudo houston browser setup" },
}));

vi.mock(import("../../state/preview"), async (original) => {
  const actual = await original();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    ...actual,
    previewEnvironment: {
      ...actual.previewEnvironment,
      hostSetup: (() => Atom.make(() => AsyncResult.success(state.status))) as never,
    },
  };
});

import { BrowserHostSetupNotice } from "./BrowserHostSetupNotice";

const environmentId = EnvironmentId.make("env-host");
const panel = () => (
  <RegistryProvider>
    <BrowserHostSetupNotice environmentId={environmentId} />
  </RegistryProvider>
);
const banner = (container: HTMLElement) => container.querySelector('[data-slot="alert"]');

it("shows the sandbox setup command and why it must run on the host", async () => {
  state.status = { blocked: true, setupCommand: "sudo houston browser setup" };
  await using screen = await render(panel(), { router: false });

  const text = screen.container.textContent ?? "";
  expect(text).toContain(
    previewStreamHostSetupMessage({ need: "sandbox", command: state.status.setupCommand }),
  );
  expect(text).toContain("sudo houston browser setup");
  expect(text).toContain("An agent cannot run it because it needs sudo.");
});

it("shows nothing when the host does not block the sandbox", async () => {
  state.status = { blocked: false, setupCommand: "" };
  await using screen = await render(panel(), { router: false });

  expect(banner(screen.container)).toBeNull();
});

it("hides the banner after a focus refetch reports the host is unblocked", async () => {
  state.status = { blocked: true, setupCommand: "sudo houston browser setup" };
  await using screen = await render(panel(), { router: false });
  expect(banner(screen.container)).not.toBeNull();

  state.status = { blocked: false, setupCommand: "" };
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });

  await vi.waitFor(() => expect(banner(screen.container)).toBeNull());
});

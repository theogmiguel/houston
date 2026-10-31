import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { PairDeviceSection } from "./AuthorizedClientsSettings";

const credential = "pair-token";
const pairingLink = {
  id: "pairing-link-1",
  scopes: [],
  subject: "device",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
} as const;

function endpoint(reachability: AdvertisedEndpoint["reachability"]): AdvertisedEndpoint {
  const host = reachability === "loopback" ? "127.0.0.1" : "192.168.1.42";
  return {
    id: `desktop-${reachability}:4780`,
    label: "This machine",
    provider: { id: "core", label: "Core", kind: "core", isAddon: false },
    httpBaseUrl: `http://${host}:4780`,
    wsBaseUrl: `ws://${host}:4780`,
    reachability,
    compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
    source: "desktop-core",
    status: "available",
    isDefault: true,
  };
}

function renderSection({
  pairingCredential = credential,
  endpoints = [endpoint("lan")],
}: {
  pairingCredential?: string | null;
  endpoints?: ReadonlyArray<AdvertisedEndpoint>;
} = {}) {
  return render(
    <PairDeviceSection
      pairingLink={pairingCredential ? pairingLink : null}
      credential={pairingCredential ?? undefined}
      endpointUrl={null}
      endpoints={endpoints}
      defaultEndpointKey={null}
    />,
  );
}

function spyOnClipboard() {
  return vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
}

describe("PairDeviceSection", () => {
  it("renders a real QR and copies the URL when the endpoint is QR-eligible", async () => {
    const writeText = spyOnClipboard();
    await using screen = await renderSection();

    await expect.element(screen.getByRole("heading", { name: "Scan to pair" })).toBeVisible();
    await expect
      .element(screen.getByRole("img", { name: "Pairing link. Scan to open on another device" }))
      .toBeVisible();
    await expect
      .element(
        screen.getByText(/^Open the link on the other device, or scan it\. The code expires in/),
      )
      .toBeVisible();

    await screen.getByRole("button", { name: "Copy link" }).click();

    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("http://192.168.1.42:4780/pair#token=pair-token"),
    );
  });

  it("offers a copy-only pairing link for an endpoint another device cannot scan", async () => {
    const writeText = spyOnClipboard();
    await using screen = await renderSection({ endpoints: [endpoint("loopback")] });

    await expect.element(screen.getByRole("heading", { name: "Pairing link" })).toBeVisible();
    await expect.element(screen.getByText(/^Open the link on the other device\./)).toBeVisible();
    await expect.element(screen.getByText(/The link expires in \d+:\d{2}\./)).toBeVisible();
    expect(screen.container.textContent).not.toContain("Scan to pair");
    expect(screen.container.querySelector("svg")).toBeNull();

    await screen.getByRole("button", { name: "Copy link" }).click();

    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:4780/pair#token=pair-token"),
    );
  });

  it("keeps the section with a disabled copy action when there is no pairing URL", async () => {
    await using screen = await renderSection({ pairingCredential: null, endpoints: [] });

    await expect.element(screen.getByRole("heading", { name: "Pairing link" })).toBeVisible();
    await expect
      .element(screen.getByText("Create a pairing link below to pair another device."))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Copy link" })).toBeDisabled();
    expect(screen.container.querySelector("svg")).toBeNull();
  });
});

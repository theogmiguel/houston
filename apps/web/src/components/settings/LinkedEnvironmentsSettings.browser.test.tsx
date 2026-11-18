import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type PeerLinkSummary } from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";

const ENVIRONMENT_ID = EnvironmentId.make("desktop");

const HOMELAB_LINK: PeerLinkSummary = {
  environmentId: EnvironmentId.make("homelab"),
  label: "Homelab",
  urls: ["http://homelab.example.ts.net:3773"],
  access: "full-access",
  linkedAt: DateTime.makeUnsafe("2026-11-18T01:55:14.129Z"),
  expiresAt: DateTime.makeUnsafe("2099-12-18T01:55:14.129Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
};

// The server's stored links. The list atom answers from them each time it is computed,
// and keeps that answer while any reader stays mounted, as the RPC query does.
const server = vi.hoisted(() => ({ links: [] as ReadonlyArray<unknown> }));
const listAtom = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("~/state/peerLinks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/state/peerLinks")>();
  const { Atom: AtomModule, AsyncResult: Result } = await import("effect/reactivity");
  listAtom.current = AtomModule.make(() => Result.success({ links: server.links }));
  return {
    ...actual,
    peerLinkEnvironment: { ...actual.peerLinkEnvironment, list: () => listAtom.current },
  };
});
const { LinkedEnvironmentsSettings } = await import("./LinkedEnvironmentsSettings");

/** Stands in for the composer, which reads the list for as long as a thread is open. */
function ComposerReader() {
  useAtomValue(listAtom.current as Atom.Atom<AsyncResult.AsyncResult<unknown>>);
  return null;
}

describe("LinkedEnvironmentsSettings", () => {
  it("lists a link made outside this client while another reader kept the list mounted", async () => {
    await using screen = await render(<ComposerReader />);

    // `houston environment link` writes the link without telling any client.
    server.links = [HOMELAB_LINK];
    await screen.rerender(
      <>
        <ComposerReader />
        <LinkedEnvironmentsSettings
          environmentId={ENVIRONMENT_ID}
          environmentLabel={null}
          isSearchTarget={false}
        />
      </>,
    );

    await expect.element(screen.getByText("Homelab")).toBeVisible();
  });
});

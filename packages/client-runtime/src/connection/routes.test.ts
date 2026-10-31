import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import { BearerConnectionTarget } from "./model.ts";
import {
  connectionRouteId,
  connectionRouteKind,
  connectionRouteLabel,
  credentialConnectionId,
  insertRoute,
  entryWithRoutes,
  mergeLearnedRoutes,
  routesAfterRemoving,
  sendsTokenInClear,
  upsertRoute,
  usableRoutes,
} from "./routes.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function direct(id: string, httpBaseUrl: string): ConnectionRoute {
  return {
    target: new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Desk",
      connectionId: id,
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId: ENVIRONMENT_ID,
        label: "Desk",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      }),
    ),
  };
}

const LAN = direct("lan", "http://192.168.1.10:3773/");
const TAILNET = direct("tailnet", "https://desk.tail1234.ts.net/");
const PUBLIC = direct("public", "https://desk.example.com/");
const HTTPS = direct("https", "https://secure.example.com/");

const entryFor = (route: ConnectionRoute): ConnectionCatalogEntry => ({
  target: route.target,
  profile: route.profile,
  enabled: true,
});

function learned(id: string, httpBaseUrl: string): ConnectionRoute {
  const route = direct(id, httpBaseUrl);
  const profile = Option.getOrThrow(route.profile) as BearerConnectionProfile;
  return {
    target: route.target,
    profile: Option.some(new BearerConnectionProfile({ ...profile, learned: true })),
  };
}

describe("connection routes", () => {
  it("classifies direct routes by address", () => {
    expect(connectionRouteKind(LAN)).toBe("lan");
    // Tailscale, Cloudflare WARP and Mesh, and other VPNs share 100.64.0.0/10.
    expect(connectionRouteKind(direct("ip", "http://100.101.102.103:3773/"))).toBe("vpn");
    expect(connectionRouteLabel(direct("mesh", "http://100.96.0.1:3773/"))).toBe("VPN");
    expect(connectionRouteKind(TAILNET)).toBe("tailnet");
    expect(connectionRouteKind(PUBLIC)).toBe("public");
    expect(connectionRouteKind(direct("lo", "http://127.0.0.1:3773/"))).toBe("loopback");
    expect(connectionRouteKind(direct("ts6", "http://[fd7a:115c:a1e0::1]:3773/"))).toBe("tailnet");
    expect(connectionRouteLabel(TAILNET)).toBe("Tailscale");
    expect(connectionRouteLabel(PUBLIC)).toBe("desk.example.com");
  });

  it("places a new route after faster kinds", () => {
    expect(insertRoute([PUBLIC], LAN)).toEqual([LAN, PUBLIC]);
    expect(insertRoute([LAN, PUBLIC], TAILNET)).toEqual([LAN, TAILNET, PUBLIC]);
    expect(insertRoute([TAILNET], LAN)).toEqual([LAN, TAILNET]);
    expect(insertRoute([LAN, TAILNET], PUBLIC)).toEqual([LAN, TAILNET, PUBLIC]);
  });

  it("keeps a user's order when a saved route is replaced", () => {
    const repaired = direct("lan", "http://192.168.1.11:3773/");
    expect(upsertRoute([PUBLIC, LAN], repaired)).toEqual([PUBLIC, repaired]);
  });
});

describe("learned routes", () => {
  const lanOnly = entryFor(LAN);
  const ids = (routes: ReadonlyArray<ConnectionRoute> | null) =>
    routes?.map((route) => connectionRouteId(route.target)) ?? null;
  const profileOf = (route: ConnectionRoute) => Option.getOrThrow(route.profile);

  it("learns a LAN address ahead of the active paired route, borrowing its token", () => {
    const routes = mergeLearnedRoutes({
      entry: lanOnly,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "http://192.168.1.20:3773/" }],
      allowInsecure: true,
    });
    expect(ids(routes)).toEqual([
      "lan",
      `learned:${ENVIRONMENT_ID}:http://192.168.1.20:3773@lan`,
    ]);
    expect(profileOf(routes![1]!)).toMatchObject({
      learned: true,
      wsBaseUrl: "ws://192.168.1.20:3773/",
    });
    expect(profileOf(routes![1]!)).not.toHaveProperty("authorization");
  });

  it("replaces a learned LAN address when the server reports a new one", () => {
    const first = mergeLearnedRoutes({
      entry: lanOnly,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "http://192.168.1.20:3773/" }],
      allowInsecure: true,
    })!;
    const entry: ConnectionCatalogEntry = {
      ...lanOnly,
      target: first[0]!.target,
      profile: first[0]!.profile,
      alternateRoutes: first.slice(1),
    };
    const moved = mergeLearnedRoutes({
      entry,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "http://10.0.0.42:3773/" }],
      allowInsecure: true,
    });
    expect(ids(moved)).toEqual(["lan", `learned:${ENVIRONMENT_ID}:http://10.0.0.42:3773@lan`]);
  });

  it("keeps a learned route where the user moved it while the server reports it", () => {
    const learnedAddress = { httpBaseUrl: "http://192.168.1.20:3773/" };
    const first = mergeLearnedRoutes({
      entry: lanOnly,
      activeRoute: LAN,
      reported: [learnedAddress],
      allowInsecure: true,
    })!;
    const reordered = entryWithRoutes(lanOnly, [first[1]!, first[0]!]);
    expect(
      mergeLearnedRoutes({
        entry: reordered,
        activeRoute: LAN,
        reported: [learnedAddress],
        allowInsecure: true,
      }),
    ).toBeNull();
  });

  it("labels a learned address Tailscale only while the server reports it as tailnet", () => {
    const tailscale = { kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" };
    const mesh = { kind: "lan", httpBaseUrl: "http://100.96.0.1:3773/" };
    const first = mergeLearnedRoutes({
      entry: lanOnly,
      activeRoute: LAN,
      reported: [tailscale, mesh],
      allowInsecure: true,
    })!;
    expect(first.map(connectionRouteLabel)).toEqual(["LAN", "Tailscale", "VPN"]);

    const corrected = mergeLearnedRoutes({
      entry: entryWithRoutes(lanOnly, first),
      activeRoute: LAN,
      reported: [{ ...tailscale, kind: "lan" }, mesh],
      allowInsecure: true,
    })!;
    expect(ids(corrected)).toEqual(ids(first));
    expect(corrected.map(connectionRouteLabel)).toEqual(["LAN", "VPN", "VPN"]);
    expect(
      mergeLearnedRoutes({
        entry: entryWithRoutes(lanOnly, corrected),
        activeRoute: LAN,
        reported: [{ ...tailscale, kind: "lan" }, mesh],
        allowInsecure: true,
      }),
    ).toBeNull();
  });

  it("leaves user routes alone and does not learn an address already saved", () => {
    const entry: ConnectionCatalogEntry = {
      target: LAN.target,
      profile: LAN.profile,
      alternateRoutes: [PUBLIC],
      enabled: true,
    };
    expect(
      mergeLearnedRoutes({
        entry,
        activeRoute: LAN,
        reported: [{ httpBaseUrl: "http://192.168.1.10:3773" }],
        allowInsecure: true,
      }),
    ).toBeNull();
    expect(
      mergeLearnedRoutes({ entry, activeRoute: LAN, reported: [], allowInsecure: true }),
    ).toBeNull();
  });

  it("borrows the paired token when learned over a bearer route", () => {
    const routes = mergeLearnedRoutes({
      entry: lanOnly,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "https://desk.tail1234.ts.net/" }],
      allowInsecure: true,
    })!;
    const tailnet = routes.find((route) => connectionRouteKind(route) === "tailnet")!;
    expect(profileOf(tailnet)).not.toHaveProperty("authorization");
    expect(credentialConnectionId(connectionRouteId(tailnet.target))).toBe("lan");
  });

  it("keeps a token paired over HTTPS off plain HTTP addresses outside the tailnet", () => {
    const entry = entryWithRoutes(entryFor(HTTPS), [HTTPS]);
    const routes = mergeLearnedRoutes({
      entry,
      activeRoute: HTTPS,
      reported: [
        { kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" },
        { kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" },
        { kind: "tailnet", httpBaseUrl: "https://desk.tail1234.ts.net/" },
      ],
      allowInsecure: true,
    });
    expect(ids(routes)).toEqual([
      `learned:${ENVIRONMENT_ID}:http://100.101.102.103:3773@https`,
      `learned:${ENVIRONMENT_ID}:https://desk.tail1234.ts.net@https`,
      "https",
    ]);
  });

  it("drops a stale plain HTTP route borrowing an HTTPS-paired token", () => {
    const lanOrigin = "http://10.0.0.42:3773";
    const stale = learned(`learned:${ENVIRONMENT_ID}:${lanOrigin}@https`, `${lanOrigin}/`);
    const entry = entryWithRoutes(entryFor(HTTPS), [stale, HTTPS]);
    expect(sendsTokenInClear([stale, HTTPS], stale)).toBe(true);
    expect(ids(usableRoutes(entry))).toEqual(["https"]);
  });

  it("keeps plain HTTP routes that don't borrow the active HTTPS-paired token", () => {
    const lanOrigin = "http://10.0.0.42:3773";
    const overLan = learned(`learned:${ENVIRONMENT_ID}:${lanOrigin}@lan`, `${lanOrigin}/`);
    const routes = mergeLearnedRoutes({
      entry: entryWithRoutes(entryFor(HTTPS), [overLan, LAN, HTTPS]),
      activeRoute: HTTPS,
      reported: [{ kind: "lan", httpBaseUrl: `${lanOrigin}/` }],
      allowInsecure: true,
    });
    expect(routes).toBeNull();
  });

  it("learns plain HTTP LAN addresses over a token paired over plain HTTP", () => {
    const entry = entryWithRoutes(lanOnly, [LAN]);
    const routes = mergeLearnedRoutes({
      entry,
      activeRoute: LAN,
      reported: [{ kind: "lan", httpBaseUrl: "http://10.0.0.42:3773/" }],
      allowInsecure: true,
    });
    expect(ids(routes)).toEqual(["lan", `learned:${ENVIRONMENT_ID}:http://10.0.0.42:3773@lan`]);
  });

  it("skips plain HTTP from an HTTPS page and never learns loopback", () => {
    expect(
      mergeLearnedRoutes({
        entry: lanOnly,
        activeRoute: LAN,
        reported: [
          { httpBaseUrl: "http://192.168.1.20:3773/" },
          { httpBaseUrl: "http://127.0.0.1:3773/" },
        ],
        allowInsecure: false,
      }),
    ).toBeNull();
  });

  it("removes learned routes along with the route whose credential they borrow", () => {
    const overLan = mergeLearnedRoutes({
      entry: lanOnly,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "https://desk.tail1234.ts.net/" }],
      allowInsecure: true,
    })!;
    expect(ids(routesAfterRemoving(overLan, "lan"))).toEqual([]);
  });

  it("saves a scheme change on the same host as a new address", () => {
    const first = mergeLearnedRoutes({
      entry: lanOnly,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "http://desk.local:3773/" }],
      allowInsecure: true,
    })!;
    const entry: ConnectionCatalogEntry = {
      ...lanOnly,
      target: first[0]!.target,
      profile: first[0]!.profile,
      alternateRoutes: first.slice(1),
    };
    const moved = mergeLearnedRoutes({
      entry,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "https://desk.local:3773/" }],
      allowInsecure: true,
    });
    expect(moved).not.toBeNull();
    expect(profileOf(moved![1]!)).toMatchObject({ httpBaseUrl: "https://desk.local:3773/" });
  });
});

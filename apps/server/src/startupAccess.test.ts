import type * as NodeOS from "node:os";

import { describe, expect, it } from "@effect/vitest";

import {
  acceptsPrivateNetworkConnection,
  buildPairingUrl,
  makePrivateNetworkRejectionLogger,
  PRIVATE_NETWORK_REJECTION_LOG_MAX_ADDRESSES,
  resolveHeadlessConnectionString,
} from "./startupAccess.ts";

const ipv4 = (address: string, internal = false): NodeOS.NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal,
  cidr: `${address}/24`,
});

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    interfaces: { en0: [ipv4("192.168.1.42")], lo0: [ipv4("127.0.0.1", true)] },
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("skips public and container addresses for a private-network listener", () => {
  const interfaces = {
    eth0: [ipv4("203.0.113.7")],
    docker0: [ipv4("172.17.0.1")],
    bridge200: [ipv4("192.168.64.1")],
    eth1: [ipv4("10.0.0.5")],
  };

  expect(resolveHeadlessConnectionString("0.0.0.0", 3773, { interfaces })).toBe(
    "http://203.0.113.7:3773",
  );
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, { interfaces, privateNetworkOnly: true }),
  ).toBe("http://10.0.0.5:3773");
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: { eth0: [ipv4("203.0.113.7")] },
      privateNetworkOnly: true,
    }),
  ).toBe("http://localhost:3773");
});

it("prefers a LAN address over a tailnet one for a private-network pairing URL", () => {
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3773, {
      interfaces: { tailscale0: [ipv4("100.101.102.103")], en0: [ipv4("192.168.1.42")] },
      privateNetworkOnly: true,
    }),
  ).toBe("http://192.168.1.42:3773");
});

describe("acceptsPrivateNetworkConnection", () => {
  const accepts = (localAddress: string | undefined, remoteAddress: string | undefined) =>
    acceptsPrivateNetworkConnection({ localAddress, remoteAddress });

  it("serves loopback, LAN, and tailnet clients", () => {
    expect(accepts("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(accepts("::ffff:192.168.1.20", "::ffff:192.168.1.31")).toBe(true);
    expect(accepts("100.101.102.103", "100.90.1.2")).toBe(true);
  });

  it("closes connections from or to a public address", () => {
    // A cloud VM's public address is NATed to a private interface address.
    expect(accepts("172.31.4.10", "203.0.113.7")).toBe(false);
    expect(accepts("203.0.113.7", "192.168.1.31")).toBe(false);
    expect(accepts("169.254.10.1", "169.254.10.2")).toBe(false);
    expect(accepts(undefined, "192.168.1.31")).toBe(false);
  });
});

describe("makePrivateNetworkRejectionLogger", () => {
  it("logs at most one line per address per minute", () => {
    let now = 0;
    const logged: string[] = [];
    const log = makePrivateNetworkRejectionLogger({
      now: () => now,
      log: (address) => logged.push(address),
    });
    log("203.0.113.7");
    log("203.0.113.7");
    now += 59_999;
    log("203.0.113.7");
    expect(logged).toEqual(["203.0.113.7"]);
    now += 1;
    log("203.0.113.7");
    expect(logged).toEqual(["203.0.113.7", "203.0.113.7"]);
    log("198.51.100.4");
    expect(logged).toEqual(["203.0.113.7", "203.0.113.7", "198.51.100.4"]);
  });

  it("names an unknown address rather than dropping the line", () => {
    const logged: string[] = [];
    const log = makePrivateNetworkRejectionLogger({
      now: () => 0,
      log: (address) => logged.push(address),
    });
    log(undefined);
    expect(logged).toEqual(["unknown"]);
  });

  it("keeps the table bounded", () => {
    const logged: string[] = [];
    const log = makePrivateNetworkRejectionLogger({
      now: () => 0,
      log: (address) => logged.push(address),
    });
    for (let index = 0; index < PRIVATE_NETWORK_REJECTION_LOG_MAX_ADDRESSES + 10; index++) {
      log(`192.0.2.${index}`);
    }
    expect(logged).toHaveLength(PRIVATE_NETWORK_REJECTION_LOG_MAX_ADDRESSES + 10);
  });
});

describe("buildPairingUrl", () => {
  it("carries the pinned identity key when one is given", () => {
    expect(buildPairingUrl("http://192.168.1.5:3773", "CODE")).toBe(
      "http://192.168.1.5:3773/pair#token=CODE",
    );
    expect(buildPairingUrl("http://192.168.1.5:3773", "CODE", { serverIdentityKey: "KEY" })).toBe(
      "http://192.168.1.5:3773/pair#token=CODE&pk=KEY",
    );
  });
});

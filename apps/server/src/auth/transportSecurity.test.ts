import { Headers } from "effect/http";
import * as Option from "effect/Option";
import { describe, expect, it } from "@effect/vitest";

import { classifyRequestTransport, isPrivateTransport } from "./transportSecurity.ts";

const request = (headers: Record<string, string>, remoteAddress?: string) => ({
  headers: Headers.fromInput(headers),
  remoteAddress: remoteAddress === undefined ? Option.none() : Option.some(remoteAddress),
});

describe("classifyRequestTransport", () => {
  it("loopback peers without forwarding headers are loopback", () => {
    expect(classifyRequestTransport(request({}, "127.0.0.1"))).toBe("loopback");
    expect(classifyRequestTransport(request({}, "::1"))).toBe("loopback");
    // SSH port forwards present as loopback traffic and count as loopback.
    expect(classifyRequestTransport(request({}, "::ffff:127.0.0.1"))).toBe("loopback");
  });

  it("Tailscale peers are tailnet, whether IPv4 CGNAT or the ULA prefix", () => {
    expect(classifyRequestTransport(request({}, "100.72.10.4"))).toBe("tailscale");
    expect(classifyRequestTransport(request({}, "fd7a:115c:a1e0::12"))).toBe("tailscale");
    // Shared-address-space addresses alone could be any CGNAT VPN; the ULA
    // prefix and .ts.net names are what identify Tailscale. Both pass the
    // private-transport gate, so a misclassification never locks anyone out.
    expect(isPrivateTransport(classifyRequestTransport(request({}, "100.100.2.3")))).toBe(true);
  });

  it("Cloudflare tunnel headers mark a tunnel even from a loopback peer", () => {
    expect(
      classifyRequestTransport(request({ "cf-connecting-ip": "203.0.113.9" }, "127.0.0.1")),
    ).toBe("tunnel");
    expect(classifyRequestTransport(request({ "cf-ray": "8f1b" }, "127.0.0.1"))).toBe("tunnel");
  });

  it("a loopback proxy is judged by the client it forwards for", () => {
    expect(
      classifyRequestTransport(request({ "x-forwarded-for": "100.72.10.4" }, "127.0.0.1")),
    ).toBe("tailscale");
    expect(
      classifyRequestTransport(request({ "x-forwarded-for": "203.0.113.9" }, "127.0.0.1")),
    ).toBe("lan-or-proxy");
  });

  it("everything else is LAN or proxy", () => {
    expect(classifyRequestTransport(request({}, "192.168.1.20"))).toBe("lan-or-proxy");
    expect(classifyRequestTransport(request({}, "203.0.113.9"))).toBe("lan-or-proxy");
    expect(classifyRequestTransport(request({}))).toBe("lan-or-proxy");
  });

  it("private transports are loopback and Tailscale only", () => {
    expect(isPrivateTransport("loopback")).toBe(true);
    expect(isPrivateTransport("tailscale")).toBe(true);
    expect(isPrivateTransport("tunnel")).toBe(false);
    expect(isPrivateTransport("lan-or-proxy")).toBe(false);
  });
});

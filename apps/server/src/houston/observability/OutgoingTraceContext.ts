// Outgoing requests carry `traceparent` and `b3` only to hosts on this machine or its private
// networks (peer servers, a local agent server, a local collector). A public API such as GitHub,
// Slack, Notion or npm would receive a correlation id and return nothing for it.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/;
const IPV6_FIRST_HEXTET = /^([0-9a-f]{1,4}):/;

// Loopback, unique local (fc00::/7) and link-local (fe80::/10) IPv6 addresses.
const isPrivateIpv6 = (address: string): boolean => {
  if (address === "::1") return true;
  const hextet = IPV6_FIRST_HEXTET.exec(address);
  if (hextet === null) return false;
  const first = Number.parseInt(hextet[1]!, 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
};

// Only addresses and the exact name `localhost`: a name under any suffix can resolve publicly.
export const isPrivateHost = (host: string): boolean => {
  const lower = host.toLowerCase();
  const name = lower.endsWith(".") ? lower.slice(0, -1) : lower;
  if (name === "localhost") return true;
  if (name.startsWith("[") && name.endsWith("]")) return isPrivateIpv6(name.slice(1, -1));
  const ipv4 = IPV4.exec(name);
  if (ipv4 === null) return false;
  const [first, second] = [Number(ipv4[1]), Number(ipv4[2])];
  return (
    first === 127 ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    // Tailscale and other carrier-grade NAT addresses.
    (first === 100 && second >= 64 && second <= 127)
  );
};

// The WHATWG parser fetch connects with: a pattern can read a different host from the same text.
export const propagatesTo = (url: string): boolean => {
  const host = URL.parse(url)?.hostname;
  return host !== undefined && isPrivateHost(host);
};

export const withPrivatePropagation = <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
  HttpClient.transform(client, (response, request) =>
    propagatesTo(request.url)
      ? response
      : Effect.provideService(response, HttpClient.TracerPropagationEnabled, false),
  );

/** The server's HTTP client with trace propagation limited to private hosts. */
export const layer = (base: Layer.Layer<HttpClient.HttpClient>) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, withPrivatePropagation),
  ).pipe(Layer.provide(base));

// Outgoing requests carry `traceparent` and `b3` only to hosts on this machine or its private
// networks (peer servers, a local agent server, a local collector). A public API such as GitHub,
// Slack, Notion or npm would receive a correlation id and return nothing for it.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";

const URL_HOST = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/;

export const isPrivateHost = (host: string): boolean => {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name.endsWith(".local") || name.endsWith(".ts.net")) return true;
  if (
    name === "::1" ||
    name.startsWith("fc") ||
    name.startsWith("fd") ||
    name.startsWith("fe80:")
  ) {
    return name.includes(":");
  }
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

export const propagatesTo = (url: string): boolean => {
  const host = URL_HOST.exec(url)?.[1];
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

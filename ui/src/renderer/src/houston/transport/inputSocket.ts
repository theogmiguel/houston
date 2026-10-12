type InputSocketResolver = (session: number) => WebSocket

const resolvers = new WeakMap<WebSocket, InputSocketResolver>()

/** Multiplexed input must use its destination's readiness and backlog. */
export function setInputSocketResolver(socket: WebSocket, resolve: InputSocketResolver): void {
  resolvers.set(socket, resolve)
}

export function inputSocketForSession(socket: WebSocket, session: number): WebSocket {
  return resolvers.get(socket)?.(session) ?? socket
}

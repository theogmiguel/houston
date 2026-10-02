const registrations = new WeakMap<object, Map<unknown, object>>()

export function registerOwned<K, V>(registry: Map<K, V>, key: K, value: V): () => void {
  let tokens = registrations.get(registry)
  if (!tokens) {
    tokens = new Map()
    registrations.set(registry, tokens)
  }
  const token = {}
  tokens.set(key, token)
  registry.set(key, value)
  return () => {
    if (tokens.get(key) !== token) return
    tokens.delete(key)
    registry.delete(key)
  }
}

const owners = new WeakMap<object, Map<number, object>>()

export function claimVisibility(client: object, session: number): {
  owns: () => boolean
  release: () => void
} {
  let registry = owners.get(client)
  if (!registry) {
    registry = new Map()
    owners.set(client, registry)
  }
  const token = {}
  const release = registerOwned(registry, session, token)
  return { owns: () => registry.get(session) === token, release }
}

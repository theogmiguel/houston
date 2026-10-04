export function changedEntries<K, V>(previous: ReadonlyMap<K, V>, next: ReadonlyMap<K, V>): [K, V][] {
  const changed: [K, V][] = []
  for (const [key, value] of next) {
    if (previous.get(key) !== value) changed.push([key, value])
  }
  return changed
}

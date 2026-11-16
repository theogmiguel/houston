import { LRUCache } from "../../lib/lruCache";

/**
 * An LRU keyed by a finished message's or block's text, bounded by entry count and by the bytes
 * of the texts it keeps alive (two per UTF-16 unit). It stores its own copy of each key: a block
 * is often a slice of a streamed message, and a slice keeps that whole message alive.
 */
export class FinishedTextCache<V> {
  private readonly entries: LRUCache<V>;

  constructor(maxEntries: number, maxBytes: number) {
    this.entries = new LRUCache<V>(maxEntries, maxBytes);
  }

  get(text: string): V | undefined {
    return this.entries.get(text) ?? undefined;
  }

  set(text: string, value: V): void {
    // JSON.parse builds a fresh string, so the key no longer references its parent.
    this.entries.set(JSON.parse(JSON.stringify(text)) as string, value, text.length * 2);
  }
}

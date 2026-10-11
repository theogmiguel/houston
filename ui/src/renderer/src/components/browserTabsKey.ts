// Legacy grid leaves keep their storage key during layout migration and cleanup.
export function tabsStorageKey(leafId: string): string {
  return `tr-browser-tabs.leaf.${leafId}`
}

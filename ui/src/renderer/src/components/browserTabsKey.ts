// Its own module because `App.tsx` needs the key as a VALUE to clear a closed
// leaf's entry — a value import pins the whole browser surface to the boot chunk,
// which is why the key is leaf-scoped here instead of living in BrowserPane.
export function tabsStorageKey(leafId: string): string {
  return `tr-browser-tabs.leaf.${leafId}`
}

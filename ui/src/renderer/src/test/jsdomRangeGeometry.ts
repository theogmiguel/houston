// jsdom implements Element geometry as empty stubs but leaves Range without it, so
// CodeMirror's measure pass logs a TypeError for every mounted editor. Give Range the
// same empty answers; node-environment files have no Range and skip this.
if (typeof Range !== 'undefined' && !('getClientRects' in Range.prototype)) {
  Object.assign(Range.prototype, {
    getClientRects: () => Object.assign([], { item: () => null }),
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, toJSON: () => ({}) })
  })
}

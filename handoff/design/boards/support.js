// Minimal stand-in for the design canvas runtime: renders <sc-for>, <sc-if>,
// {{path}} text/attribute bindings and onClick handlers from a DCLogic component.
(function () {
  class DCLogic {
    constructor(props) { this.props = props; this.state = {}; }
    setState(patch) {
      this.state = { ...this.state, ...(typeof patch === "function" ? patch(this.state) : patch) };
      render();
    }
  }
  window.DCLogic = DCLogic;

  let comp, template;
  const get = (scope, path) => path.trim().split(".").reduce((o, k) => (o == null ? undefined : o[k]), scope);
  const truthy = (v) => (Array.isArray(v) ? v.length > 0 : !!v);
  const whole = /^\{\{\s*([\w.$]+)\s*\}\}$/;
  const interp = (s, scope) => s.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (_, p) => { const v = get(scope, p); return v == null ? "" : String(v); });

  function walk(node, scope) {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) { if (child.nodeValue.includes("{{")) child.nodeValue = interp(child.nodeValue, scope); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === "sc-for") {
        const m = whole.exec(child.getAttribute("list") || "");
        const list = m ? get(scope, m[1]) || [] : [];
        const as = child.getAttribute("as") || "item";
        const frag = document.createDocumentFragment();
        list.forEach((item, i) => {
          const box = document.createElement("div");
          for (const c of child.childNodes) box.appendChild(c.cloneNode(true));
          walk(box, { ...scope, [as]: item, $index: i });
          while (box.firstChild) frag.appendChild(box.firstChild);
        });
        child.replaceWith(frag);
        continue;
      }
      if (tag === "sc-if") {
        const m = whole.exec(child.getAttribute("value") || "");
        if (m && truthy(get(scope, m[1]))) {
          walk(child, scope);
          child.replaceWith(...child.childNodes);
        } else child.remove();
        continue;
      }
      if (tag === "script") continue;
      for (const attr of [...child.attributes]) {
        if (!attr.value.includes("{{")) continue;
        const m = whole.exec(attr.value);
        if (attr.name.startsWith("on")) {
          child.removeAttribute(attr.name);
          const fn = m && get(scope, m[1]);
          if (typeof fn === "function") child.addEventListener(attr.name.slice(2), fn);
        } else child.setAttribute(attr.name, interp(attr.value, scope));
      }
      walk(child, scope);
    }
  }

  function render() {
    const scope = { ...comp.props, ...comp.state, ...(comp.renderVals ? comp.renderVals() : {}) };
    const root = template.cloneNode(true);
    walk(root, scope);
    document.body.replaceChildren(...root.childNodes);
  }

  addEventListener("DOMContentLoaded", () => {
    const src = document.querySelector("script[data-dc-script]");
    if (!src) return;
    const props = {};
    try {
      for (const [k, v] of Object.entries(JSON.parse(src.getAttribute("data-props") || "{}"))) if (!k.startsWith("$")) props[k] = v.default;
    } catch (e) { console.error("support.js: bad data-props", e); }
    props.theme = document.querySelector("[data-theme]")?.getAttribute("data-theme") || props.theme;
    const Component = new Function("DCLogic", src.textContent + "\nreturn Component;")(DCLogic);
    template = document.createElement("div");
    for (const n of document.body.childNodes) if (!(n.nodeType === 1 && n.tagName === "SCRIPT")) template.appendChild(n.cloneNode(true));
    comp = new Component(props);
    render();
    comp.componentDidMount?.();
  });
})();

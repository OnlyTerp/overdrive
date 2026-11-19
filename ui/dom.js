// Zero-dependency CSP & XSS-safe DOM helpers (lazy document lookup for Node tests).

const SVG_NS = "http://www.w3.org/2000/svg";
const FORBIDDEN_ATTRS = new Set(["innerhtml", "outerhtml", "insertadjacenthtml", "style", "srcdoc"]);

function docOf() {
  const d = globalThis.document;
  if (!d) throw new Error("DOM unavailable in current context; pass createMockDom() first.");
  return d;
}

function assertSafeAttr(key, value) {
  const lower = String(key).toLowerCase();
  if (FORBIDDEN_ATTRS.has(lower)) {
    throw new Error(`CSP/XSS policy forbids setting attribute "${key}". Use CSS classes or data-* attributes.`);
  }
  if (lower.startsWith("on") && typeof value === "string") {
    throw new Error(`CSP policy forbids inline string event handler "${key}". Pass a function listener instead.`);
  }
}

function applyAttrs(node, attrs, isSvg) {
  if (!attrs || typeof attrs !== "object") return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    assertSafeAttr(k, v);
    if (k === "className" || k === "class") {
      if (isSvg) node.setAttribute("class", String(v));
      else node.className = String(v);
    } else if (k === "dataset" && typeof v === "object") {
      for (const [dk, dv] of Object.entries(v)) {
        if (dv !== undefined && dv !== null) {
          if (node.dataset) node.dataset[dk] = String(dv);
          else node.setAttribute(`data-${dk.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, String(dv));
        }
      }
    } else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "textContent") {
      node.textContent = String(v);
    } else if (v === true) {
      node.setAttribute(k, "");
      if (k === "disabled" || k === "hidden") node[k] = true;
    } else {
      node.setAttribute(k, String(v));
    }
  }
}

function appendChildren(node, children) {
  const d = docOf();
  for (const ch of children.flat(Infinity)) {
    if (ch === undefined || ch === null || ch === false) continue;
    if (typeof ch === "string" || typeof ch === "number") {
      node.appendChild(d.createTextNode(String(ch)));
    } else {
      node.appendChild(ch);
    }
  }
}

export function h(tag, attrs = null, ...children) {
  const el = docOf().createElement(tag);
  applyAttrs(el, attrs, false);
  appendChildren(el, children);
  return el;
}

export function svg(tag, attrs = null, ...children) {
  const el = docOf().createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs, true);
  appendChildren(el, children);
  return el;
}

export function clear(node) {
  if (!node) return node;
  if (typeof node.replaceChildren === "function") {
    node.replaceChildren();
  } else {
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  return node;
}

export function setChildren(node, ...children) {
  clear(node);
  appendChildren(node, children);
  return node;
}

/** Build text fragment with <mark> highlights strictly from match indices (no HTML parsing). */
export function highlightMatches(text, indices = [], markClass = "od-mark") {
  const s = String(text ?? "");
  if (!indices || indices.length === 0) return [docOf().createTextNode(s)];
  const hit = new Set(indices);
  const out = [];
  let buf = "";
  let inMark = false;
  const flush = () => {
    if (!buf) return;
    out.push(inMark ? h("mark", { className: markClass }, buf) : docOf().createTextNode(buf));
    buf = "";
  };
  for (let i = 0; i < s.length; i++) {
    const m = hit.has(i);
    if (m !== inMark) {
      flush();
      inMark = m;
    }
    buf += s[i];
  }
  flush();
  return out;
}

/** Lightweight zero-dependency DOM mock for Node.js unit tests across all UI lanes. */
export function createMockDom() {
  class MockClassList {
    constructor(el) {
      this._el = el;
    }
    _set() {
      return new Set(String(this._el._attrs.class || "").split(/\s+/).filter(Boolean));
    }
    _write(set) {
      this._el._attrs.class = [...set].join(" ");
    }
    add(...names) {
      const s = this._set();
      for (const n of names) if (n) s.add(n);
      this._write(s);
    }
    remove(...names) {
      const s = this._set();
      for (const n of names) s.delete(n);
      this._write(s);
    }
    toggle(name, force) {
      const s = this._set();
      const should = force === undefined ? !s.has(name) : Boolean(force);
      if (should) s.add(name);
      else s.delete(name);
      this._write(s);
      return should;
    }
    contains(name) {
      return this._set().has(name);
    }
  }

  class MockNode {
    constructor(nodeType, nodeName, ns = null) {
      this.nodeType = nodeType;
      this.nodeName = nodeName;
      this.tagName = nodeType === 1 ? nodeName : undefined;
      this.namespaceURI = ns;
      this.childNodes = [];
      this.parentNode = null;
      this._attrs = {};
      this._listeners = new Map();
      this._text = "";
      this.value = "";
      this.disabled = false;
      this.hidden = false;
      this.classList = nodeType === 1 ? new MockClassList(this) : null;
      this.dataset = {};
    }
    get className() {
      return this._attrs.class || "";
    }
    set className(v) {
      this._attrs.class = String(v);
    }
    get id() {
      return this._attrs.id || "";
    }
    set id(v) {
      this._attrs.id = String(v);
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    get textContent() {
      if (this.nodeType === 3) return this._text;
      return this.childNodes.map((c) => c.textContent).join("");
    }
    set textContent(v) {
      if (this.nodeType === 3) {
        this._text = String(v ?? "");
      } else {
        this.childNodes = [];
        if (v !== undefined && v !== null && String(v) !== "") {
          this.appendChild(new MockNode(3, "#text"));
          this.childNodes[0]._text = String(v);
          this.childNodes[0].parentNode = this;
        }
      }
    }
    setAttribute(k, v) {
      if (String(k).toLowerCase() === "style") throw new Error("MockDom: inline style forbidden");
      this._attrs[k] = String(v);
      if (k.startsWith("data-")) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[camel] = String(v);
      }
    }
    getAttribute(k) {
      return k in this._attrs ? this._attrs[k] : null;
    }
    removeAttribute(k) {
      delete this._attrs[k];
    }
    hasAttribute(k) {
      return k in this._attrs;
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    append(...items) {
      for (const item of items) {
        this.appendChild(typeof item === "string" ? doc.createTextNode(item) : item);
      }
    }
    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx >= 0) {
        this.childNodes.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    }
    replaceChildren(...items) {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = [];
      this.append(...items);
    }
    addEventListener(type, fn) {
      const list = this._listeners.get(type) || [];
      list.push(fn);
      this._listeners.set(type, list);
    }
    removeEventListener(type, fn) {
      const list = this._listeners.get(type) || [];
      this._listeners.set(type, list.filter((x) => x !== fn));
    }
    dispatchEvent(ev) {
      const e = typeof ev === "string" ? { type: ev, target: this } : { target: this, preventDefault() {}, stopPropagation() {}, ...ev };
      for (const fn of this._listeners.get(e.type) || []) fn(e);
      return true;
    }
    click() {
      this.dispatchEvent({ type: "click" });
    }
    focus() {
      doc.activeElement = this;
    }
    _matches(selector) {
      if (this.nodeType !== 1) return false;
      const sel = selector.trim();
      if (sel.startsWith("#")) return this.id === sel.slice(1);
      if (sel.startsWith(".")) return this.classList.contains(sel.slice(1));
      const mAttr = sel.match(/^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/);
      if (mAttr) return mAttr[2] !== undefined ? this.getAttribute(mAttr[1]) === mAttr[2] : this.hasAttribute(mAttr[1]);
      return String(this.tagName).toLowerCase() === sel.toLowerCase();
    }
    querySelectorAll(selector) {
      const out = [];
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (c._matches(selector)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  const doc = {
    body: new MockNode(1, "body"),
    documentElement: new MockNode(1, "html"),
    activeElement: null,
    createElement: (tag) => new MockNode(1, String(tag).toLowerCase()),
    createElementNS: (ns, tag) => new MockNode(1, String(tag), ns),
    createTextNode: (txt) => {
      const n = new MockNode(3, "#text");
      n._text = String(txt ?? "");
      return n;
    },
    getElementById(id) {
      return this.body.querySelector(`#${id}`);
    },
    querySelector(s) {
      return this.body.querySelector(s);
    },
    querySelectorAll(s) {
      return this.body.querySelectorAll(s);
    },
  };
  return doc;
}

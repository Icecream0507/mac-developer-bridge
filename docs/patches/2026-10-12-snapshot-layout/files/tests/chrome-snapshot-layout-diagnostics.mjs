import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// Source-only fixtures. This test never opens a browser, connects to a bridge,
// accesses a profile, sends a network request or changes permissions.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "chrome-extension/service-worker.js"), "utf8");
const bridge = await fs.readFile(path.join(root, "bridge.mjs"), "utf8");
const baselineRoot = process.argv[2] ? path.resolve(process.argv[2]) : null;
const baseline = baselineRoot ? await fs.readFile(path.join(baselineRoot, "chrome-extension/service-worker.js"), "utf8") : null;
function extractSnapshot(text) {
  const start = text.indexOf("function pageSnapshot(");
  const end = text.indexOf("\n\nasync function pagePasteContent(", start);
  assert.ok(start >= 0 && end > start);
  return text.slice(start, end);
}
const snapshotSource = extractSnapshot(source);
const results = [];
async function scenario(name, run) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message, stack: error.stack }); }
}
const plain = value => JSON.parse(JSON.stringify(value));
function* descendants(root) {
  const pending = [...root.children].reverse();
  while (pending.length) {
    const node = pending.pop();
    yield node;
    for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
  }
}
class FakeRoot {
  constructor(document = null, mode = null, host = null) {
    this.ownerDocument = document; this.mode = mode; this.host = host;
    this.children = []; this.parentNode = null; this.activeElement = null;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      node.ownerDocument = this instanceof FakeDocument ? this : this.ownerDocument;
      this.children.push(node);
    }
  }
  querySelectorAll(selector) { return [...descendants(this)].filter(node => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getElementById(id) { return [...descendants(this)].find(node => node.id === id) || null; }
}
class FakeElement extends FakeRoot {
  constructor(tag = "div", attrs = {}, rect = {}, css = {}) {
    super();
    this.nodeType = 1; this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attrs)); this.shadowRoot = null;
    this.isContentEditable = false; this.disabled = false; this.readOnly = false;
    this.rect = { x: 10, y: 20, width: 300, height: 100, ...rect };
    this.css = { display: "block", visibility: "visible", opacity: "1",
      contentVisibility: "visible", overflowX: "visible", overflowY: "visible", transform: "none", ...css };
    this.rectReads = 0; this.styleReads = 0; this.textReads = 0;
    this.text = ""; this.forbidText = false;
  }
  get parentElement() { return this.parentNode instanceof FakeElement ? this.parentNode : null; }
  get id() { return this.getAttribute("id") || ""; }
  get isConnected() {
    const root = this.getRootNode();
    return root instanceof FakeDocument || (root.mode === "open" && root.host?.isConnected === true);
  }
  getRootNode() { let node = this; while (node.parentNode) node = node.parentNode; return node; }
  attach(mode = "open") {
    const shadow = new FakeRoot(this.ownerDocument, mode, this);
    if (mode === "open") this.shadowRoot = shadow;
    return shadow;
  }
  get innerText() { this.textReads++; if (this.forbidText) throw new Error("PRIVATE_TEXT_READ"); return this.text; }
  get textContent() { throw new Error("PRIVATE_TEXT_CONTENT_READ"); }
  get innerHTML() { throw new Error("PRIVATE_HTML_READ"); }
  get outerHTML() { throw new Error("PRIVATE_HTML_READ"); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  matches(selector) {
    if (selector.startsWith("a[href],button,input,textarea,select,")) return false;
    if (selector === 'input[type="file"]') return false;
    if (selector.startsWith(".")) return (this.attributes.get("class") || "").split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    return selector === "*" || selector.toLowerCase() === this.tagName.toLowerCase();
  }
  getBoundingClientRect() { this.rectReads++; if (this.throwRect) throw new Error("PRIVATE_ERROR"); return this.rect; }
  dispatchEvent() { throw new Error("No events permitted"); }
  focus() { throw new Error("No focus changes permitted"); }
  click() { throw new Error("No clicks permitted"); }
  scrollIntoView() { throw new Error("No scrolling permitted"); }
  setAttribute() { throw new Error("No DOM mutation permitted"); }
}
class FakeInput extends FakeElement {}
class FakeTextarea extends FakeElement {}
class FakeSelect extends FakeElement {}
class FakeAnchor extends FakeElement {}
class FakeDocument extends FakeRoot {
  constructor() {
    super(); this.ownerDocument = this; this.title = "DOM layout fixture"; this.walked = 0;
    this.visibilityState = "visible"; this.focusReads = 0;
    this.documentElement = new FakeElement("html"); this.append(this.documentElement);
    this.body = new FakeElement("body"); this.body.text = "Public builder chrome";
    this.documentElement.append(this.body);
  }
  hasFocus() { this.focusReads++; return false; }
  createTreeWalker(root) {
    const iterator = descendants(root);
    return { nextNode: () => { this.walked++; return iterator.next().value || null; } };
  }
}
function fixture(text = snapshotSource) {
  const document = new FakeDocument();
  const context = vm.createContext({
    document, window: { innerWidth: 1200, innerHeight: 800 },
    location: { href: "https://fixture.invalid/builder" },
    Element: FakeElement, HTMLElement: FakeElement, HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextarea, HTMLSelectElement: FakeSelect, HTMLAnchorElement: FakeAnchor,
    CSS: { escape: value => value }, URL, Date,
    getComputedStyle(element) { element.styleReads++; return element.css; },
    performance: { getEntriesByType() { return []; } },
    fetch() { throw new Error("No network access permitted"); },
    Event: class { constructor() { throw new Error("No events permitted"); } },
  });
  return { document, context, snapshot: vm.runInContext("(" + text + ")", context) };
}
const add = (f, className, rect = {}, css = {}, parent = f.document.body, tag = "div") => {
  const element = new FakeElement(tag, className ? { class: className } : {}, rect, css);
  parent.append(element); return element;
};
const read = (f, maxElements = 500) => f.snapshot(20000, maxElements, { includeLayout: true }).layoutDiagnostics;

await scenario("opt-in-only-and-default-payload-compatible-with-captured-baseline", () => {
  const f = fixture(); add(f, "react-flow__node");
  assert.equal("layoutDiagnostics" in f.snapshot(20000, 200), false);
  assert.equal("layoutDiagnostics" in f.snapshot(20000, 200, { includeLayout: false }), false);
  assert.equal("layoutDiagnostics" in f.snapshot(20000, 200, { includeLayout: "true" }), false);
  assert.equal(f.document.focusReads, 0, "default does not perform the additional passive focus read");
  if (baseline) {
    const old = fixture(extractSnapshot(baseline)); add(old, "react-flow__node");
    assert.deepEqual(plain(f.snapshot(20000, 200)), plain(old.snapshot(20000, 200)));
    const extra = plain(f.snapshot(20000, 200, { includeLayout: true })); delete extra.layoutDiagnostics;
    assert.deepEqual(extra, plain(old.snapshot(20000, 200)));
  }
});
await scenario("noninteractive-graph-presence-is-independent-of-control-filter", () => {
  const f = fixture();
  const graph = add(f, "react-flow");
  const renderer = add(f, "react-flow__renderer", {}, {}, graph);
  const pane = add(f, "react-flow__pane", {}, {}, renderer);
  const viewport = add(f, "react-flow__viewport", {}, { transform: "matrix(1.2, 0, 0, 1.2, 22, -18)" }, pane);
  const container = add(f, "react-flow__nodes", {}, {}, viewport);
  add(f, "react-flow__node", {}, {}, container);
  const snapshot = f.snapshot(20000, 500, { includeLayout: true });
  assert.equal(snapshot.elements.length, 0);
  assert.equal(snapshot.bodyText, "Public builder chrome");
  const d = snapshot.layoutDiagnostics;
  for (const key of ["graphRoots", "renderers", "panes", "viewports", "nodeContainers", "nodes"])
    assert.equal(d.groups[key].count, 1, key);
  const node = d.groups.nodes.samples[0];
  assert.equal(node.hasArea, true); assert.equal(node.intersectsViewport, true); assert.equal(node.localStyleHidden, false);
  assert.deepEqual(plain(d.groups.viewports.samples[0].style.transform), { type: "matrix", values: [1.2, 0, 0, 1.2, 22, -18] });
  assert.deepEqual(plain(d.viewport), { width: 1200, height: 800 });
  assert.equal(d.documentHasFocus, false); assert.equal(d.documentVisibility, "visible");
});
await scenario("zero-size-hidden-transparent-content-hidden-and-offscreen-remain-distinct", () => {
  const f = fixture();
  add(f, "react-flow__node", { width: 0 });
  add(f, "react-flow__node", {}, { visibility: "hidden" });
  add(f, "react-flow__node", {}, { opacity: "0" });
  add(f, "react-flow__node", {}, { contentVisibility: "hidden" });
  add(f, "react-flow__node", { x: 2000 });
  add(f, "react-flow__node", { x: -100, width: 150 });
  add(f, "react-flow__node", {}, { visibility: "collapse" });
  add(f, "react-flow__node", {}, { display: "none" });
  const samples = read(f).groups.nodes.samples;
  assert.equal(samples[0].hasArea, false); assert.equal(samples[0].intersectsViewport, false);
  for (const index of [1, 2, 3, 6, 7]) assert.equal(samples[index].localStyleHidden, true);
  assert.equal(samples[4].intersectsViewport, false); assert.equal(samples[4].hasArea, true);
  assert.equal(samples[4].localStyleHidden, false);
  assert.equal(samples[5].intersectsViewport, true);
});
await scenario("samples-and-measurement-reads-are-capped-while-counts-remain-exact", () => {
  const f = fixture(), nodes = [];
  for (let i = 0; i < 1000; i++) nodes.push(add(f, "react-flow__node"));
  for (let i = 0; i < 10; i++) {
    add(f, "react-flow"); add(f, "", {}, {}, f.document.body, "svg");
    add(f, "", {}, {}, f.document.body, "canvas"); add(f, "", {}, {}, f.document.body, "iframe");
  }
  const d = read(f);
  assert.equal(d.groups.nodes.count, 1000); assert.equal(d.groups.nodes.samples.length, 50);
  assert.equal(nodes.reduce((total, element) => total + element.rectReads, 0), 50);
  assert.equal(nodes.reduce((total, element) => total + element.styleReads, 0), 50);
  assert.equal(d.groups.nodes.samplesTruncated, true);
  assert.equal(d.groups.graphRoots.samples.length, 4);
  for (const key of ["svg", "canvas", "frames"]) {
    assert.equal(d.groups[key].count, 10); assert.equal(d.groups[key].samples.length, 8);
    assert.equal(d.groups[key].samplesTruncated, true);
  }
  assert.ok(JSON.stringify(d).length < 100000, "fixed caps also bound serialized diagnostics");
  const low = read(f, 2);
  for (const key of ["graphRoots", "nodes", "svg", "canvas", "frames"])
    assert.equal(low.groups[key].samples.length, 2, "max_elements also limits each diagnostic sample group");
});
await scenario("root-ancestor-chain-stops-after-eight-and-includes-zero-size-container", () => {
  const f = fixture(); let parent = f.document.body;
  for (let i = 0; i < 12; i++) parent = add(f, "", i === 11 ? { height: 0 } : {}, {}, parent);
  add(f, "react-flow", {}, {}, parent);
  const root = read(f).groups.graphRoots.samples[0];
  assert.equal(root.ancestors.length, 8); assert.equal(root.ancestorsTruncated, true);
  assert.equal(root.ancestors[0].hasArea, false); assert.equal(root.ancestors[0].rect.height, 0);
});
await scenario("existing-open-root-scope-excludes-closed-root-and-frame-content", () => {
  const f = fixture();
  const openHost = add(f, ""); const open = openHost.attach();
  const openNode = add(f, "react-flow__node", {}, {}, open); openNode.text = "";
  const closedHost = add(f, ""); const closed = closedHost.attach("closed");
  add(f, "react-flow__node", {}, {}, closed);
  const frame = add(f, "", {}, {}, f.document.body, "iframe");
  for (const key of ["contentDocument", "contentWindow", "src", "srcdoc"])
    Object.defineProperty(frame, key, { get() { throw new Error("Frame boundary read"); } });
  const canvas = add(f, "", {}, {}, f.document.body, "canvas");
  for (const key of ["getContext", "toDataURL", "toBlob"])
    Object.defineProperty(canvas, key, { get() { throw new Error("Canvas content read"); } });
  const d = read(f);
  assert.equal(d.groups.nodes.count, 1); assert.equal(d.groups.frames.count, 1); assert.equal(d.groups.canvas.count, 1);
  assert.equal(d.scope, "document-and-open-shadow-roots");
});
await scenario("layout-does-not-read-text-html-labels-framework-state-or-dispatch-events", () => {
  const f = fixture();
  const node = add(f, "react-flow__node", {}, { display: "PRIVATE_STYLE_CANARY", transform: "PRIVATE_TRANSFORM_CANARY" });
  for (const key of ["id", "name", "aria-label", "data-testid", "data-private"])
    node.attributes.set(key, "PRIVATE_ATTRIBUTE_CANARY");
  node.forbidText = true;
  for (const key of ["__reactFiber$private", "__reactProps$private", "value", "dataset", "style"])
    Object.defineProperty(node, key, { get() { throw new Error("Private state read"); } });
  const d = read(f);
  assert.equal(node.textReads, 0);
  const serialized = JSON.stringify(d);
  assert.ok(!serialized.includes("PRIVATE"));
  assert.equal(d.groups.nodes.samples[0].style.display, null);
  assert.equal(d.groups.nodes.samples[0].style.transform, null);
  assert.deepEqual(Object.keys(d.groups.nodes.samples[0]).sort(),
    ["elementIndex", "geometryKnown", "hasArea", "intersectsViewport", "localStyleHidden", "rect", "style", "tag"].sort());
});
await scenario("invalid-or-extreme-numbers-and-unrecognized-css-never-cross-output", () => {
  const f = fixture();
  add(f, "react-flow__node", { x: Infinity, y: 1e12, width: NaN, height: 1e8 },
    { opacity: "SECRET", visibility: "SECRET", overflowX: "SECRET", transform: "matrix(1e100, 0, 0, 1, 0, 0)" });
  const s = read(f).groups.nodes.samples[0];
  assert.deepEqual(plain(s.rect), { x: null, y: null, width: null, height: null });
  assert.equal(s.geometryKnown, false); assert.equal(s.intersectsViewport, null); assert.equal(s.style.opacity, null);
  assert.equal(s.style.transform, null); assert.ok(!JSON.stringify(s).includes("SECRET"));
});
await scenario("detached-nodes-and-measurement-errors-are-safe-and-bounded", () => {
  const f = fixture();
  const detached = add(f, "react-flow__node");
  Object.defineProperty(detached, "isConnected", { get() { return false; } });
  const broken = add(f, "react-flow__node"); broken.throwRect = true;
  const d = read(f);
  assert.equal(d.groups.nodes.count, 1);
  assert.deepEqual(Object.keys(d.groups.nodes.samples[0]).sort(), ["elementIndex", "measurementFailed"]);
  assert.equal(d.groups.nodes.samples[0].measurementFailed, true);
  assert.ok(!JSON.stringify(d).includes("PRIVATE_ERROR"));
});
await scenario("existing-twenty-thousand-node-budget-yields-lower-bound-counts", () => {
  const f = fixture();
  for (let i = 0; i < 20010; i++) add(f, "react-flow__node");
  const d = read(f, 10);
  assert.equal(d.observedElements, 20000); assert.equal(d.countsAreLowerBounds, true);
  assert.equal(d.groups.nodes.count, 19998); assert.equal(d.groups.nodes.samples.length, 10);
  assert.equal(f.document.walked, 20001, "diagnostic does not start a new DOM walk");
});
function caseSource(text, name) {
  const start = text.indexOf('    case "' + name + '": {');
  assert.ok(start >= 0);
  const end = text.indexOf("\n    case ", start + 1);
  assert.ok(end > start);
  return text.slice(start, end);
}
await scenario("bridge-option-is-strict-and-default-wire-arguments-remain-unchanged", async () => {
  const calls = [];
  const helperStart = bridge.indexOf("function optionalBoolean(");
  const helperEnd = bridge.indexOf("\n}", helperStart);
  const optionalBoolean = vm.runInNewContext("(" + bridge.slice(helperStart, helperEnd + 2) + ")");
  const dispatch = vm.runInNewContext("(async function(args){ const name = 'chrome_snapshot'; switch(name) {"
    + caseSource(bridge, "chrome_snapshot") + "}})", {
    optionalBoolean,
    requireInteger: (args, key) => args[key],
    optionalInteger: (args, key, fallback) => args[key] ?? fallback,
    callBackgroundChrome: async (...args) => { calls.push(plain(args)); return {}; },
  });
  await dispatch({ tab_id: 42 });
  assert.deepEqual(calls.pop(), ["chrome_snapshot", "tabs.snapshot", { tabId: 42, maxTextChars: 50000, maxElements: 200 }]);
  await dispatch({ tab_id: 42, include_layout: false });
  assert.deepEqual(calls.pop()[2], { tabId: 42, maxTextChars: 50000, maxElements: 200 });
  await dispatch({ tab_id: 42, include_layout: true });
  assert.equal(calls.pop()[2].includeLayout, true);
  await assert.rejects(() => dispatch({ tab_id: 42, include_layout: "true" }), /must be a boolean/);
  assert.equal(calls.length, 0, "bad input never reaches Chrome");
});
await scenario("worker-still-requires-approved-tab-isolated-world-deadline-and-document-binding", async () => {
  const events = []; let denied = false;
  const snapshot = function pageSnapshot() {};
  const dispatch = vm.runInNewContext("(async function(args){ const compiled = {}; const message = { deadlineMs: 12345 }; switch('tabs.snapshot'){"
    + caseSource(source, "tabs.snapshot") + "}})", {
    pageSnapshot: snapshot,
    getApprovedTab: async (id, compiled) => { events.push(["grant", id]); if (denied) throw new Error("CHROME_TAB_NOT_APPROVED"); return { id }; },
    executeInTab: async (...args) => { events.push(["execute", ...args]); return {}; },
  });
  await dispatch({ tabId: 42 });
  assert.equal(events[0][0], "grant"); assert.equal(events[1][0], "execute");
  let call = events[1].slice(1);
  assert.equal(call[0], 42); assert.equal(call[1], snapshot);
  assert.deepEqual(plain(call[2]), [50000, 200]); assert.equal(call[3], "ISOLATED");
  assert.deepEqual(plain(call[4]), { deadlineMs: 12345, includeDocumentIdentity: true });
  events.length = 0;
  await dispatch({ tabId: 42, includeLayout: true });
  assert.deepEqual(plain(events[1][3]), [50000, 200, { includeLayout: true }]);
  events.length = 0; denied = true;
  await assert.rejects(() => dispatch({ tabId: 42, includeLayout: true }), /CHROME_TAB_NOT_APPROVED/);
  assert.deepEqual(events, [["grant", 42]], "denial stops before execution");
});
const summary = { passed: results.filter(result => result.passed).length, total: results.length, baselineCompared: Boolean(baselineRoot), results };
console.log(JSON.stringify(summary, null, 2));
if (summary.passed !== summary.total) process.exitCode = 1;

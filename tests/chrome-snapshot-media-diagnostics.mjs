import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "chrome-extension/service-worker.js"), "utf8");
const start = source.indexOf("function pageSnapshot(");
const end = source.indexOf("\n\nasync function pagePasteContent(", start);
assert.ok(start >= 0 && end > start, "pageSnapshot should remain a self-contained source function");
const snapshotSource = source.slice(start, end);

let dispatchCount = 0;
class FakeRoot {
  constructor(document = null, mode = null, host = null) {
    this.ownerDocument = document;
    this.mode = mode;
    this.host = host;
    this.children = [];
    this.parentNode = null;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      node.ownerDocument = this instanceof FakeDocument ? this : (this.ownerDocument || this.host?.ownerDocument);
      this.children.push(node);
    }
  }
  getElementById(id) {
    return this.querySelectorAll("#" + id)[0] || null;
  }
  querySelectorAll(selector) {
    return [...descendants(this)].filter(node => node.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class FakeElement extends FakeRoot {
  constructor(tag, attributes = {}, { visible = true, text = "" } = {}) {
    super();
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.visible = visible;
    this.text = text;
    this.shadowRoot = null;
    this.isContentEditable = false;
    this.disabled = false;
    this.readOnly = false;
    this.currentSrc = "";
    this.src = "";
  }
  get id() { return this.getAttribute("id") || ""; }
  get isConnected() {
    const root = this.getRootNode();
    return root instanceof FakeDocument || (root instanceof FakeRoot && root.mode === "open" && root.host?.isConnected === true);
  }
  get parentElement() { return this.parentNode instanceof FakeElement ? this.parentNode : null; }
  get innerText() { return this.text || this.children.map(child => child.innerText || child.textContent || "").join(""); }
  get textContent() { return this.innerText; }
  get childrenElements() { return this.children; }
  getRootNode() {
    let current = this.parentNode;
    while (current && current.parentNode) current = current.parentNode;
    return current || this;
  }
  attachShadow({ mode = "open" } = {}) {
    this.shadowRoot = new FakeRoot(this.ownerDocument, mode, this);
    return this.shadowRoot;
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  matches(selector) {
    if (selector === ":disabled") return this.disabled;
    if (selector.startsWith("a[href],button,input,textarea,select,")) {
      return ["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"].includes(this.tagName)
        || this.hasAttribute("role") || this.hasAttribute("tabindex") || this.isContentEditable;
    }
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector === "source") return this.tagName === "SOURCE";
    if (selector === "*") return true;
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  getBoundingClientRect() {
    return this.visible
      ? { x: 1, y: 2, left: 1, top: 2, width: 320, height: 180, right: 321, bottom: 182 }
      : { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }
  dispatchEvent() { dispatchCount += 1; return true; }
  closest() { return null; }
}
class HTMLElement extends FakeElement {}
class HTMLInputElement extends HTMLElement {}
class HTMLTextAreaElement extends HTMLElement {}
class HTMLSelectElement extends HTMLElement {}
class HTMLAnchorElement extends HTMLElement {}
class FakeDocument extends FakeRoot {
  constructor() {
    super();
    this.title = "Snapshot media fixture";
    this.documentElement = new FakeElement("html");
    this.body = new FakeElement("body");
    this.append(this.documentElement);
    this.documentElement.append(this.body);
  }
  createTreeWalker(root) {
    const nodes = [...descendants(root)];
    let index = 0;
    return { nextNode: () => nodes[index++] || null };
  }
}
function* descendants(root) {
  const stack = [...root.children].reverse();
  while (stack.length) {
    const node = stack.pop();
    yield node;
    for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]);
  }
}

function makeTiming(index, overrides = {}) {
  return {
    name: "https://cdn.example.test/resource-" + index + ".mp4?signature=SECRET_QUERY#SECRET_FRAGMENT",
    startTime: index * 2,
    duration: 50 + index,
    transferSize: 1000 + index,
    encodedBodySize: 900 + index,
    decodedBodySize: 800 + index,
    initiatorType: "xmlhttprequest",
    responseStatus: 200,
    ...overrides,
  };
}

const document = new FakeDocument();
const host = new FakeElement("media-shell", { id: "media-shell" });
document.body.append(host);
const shadow = host.attachShadow({ mode: "open" });

const visibleVideo = new FakeElement("video", { id: "visible-video" }, { visible: true });
Object.assign(visibleVideo, {
  currentSrc: "https://media.example.test/visible.mp4?token=VIDEO_SECRET#video-fragment",
  duration: 12.5, currentTime: 2, readyState: 4, networkState: 1,
  paused: true, ended: false, muted: false, controls: true,
  videoWidth: 1920, videoHeight: 1080, error: null,
});
document.body.append(visibleVideo);

const hiddenVideo = new FakeElement("video", { id: "hidden-video" }, { visible: false });
Object.assign(hiddenVideo, {
  currentSrc: "https://media.example.test/stalled.mp4?signature=HIDDEN_VIDEO_SECRET#private",
  duration: NaN, currentTime: 0, readyState: 1, networkState: 2,
  paused: true, ended: false, muted: false, controls: false,
  videoWidth: 0, videoHeight: 0, error: { code: 4, message: "PRIVATE_MEDIA_ERROR_TEXT" },
});
const sourceNode = new FakeElement("source");
sourceNode.src = "https://media.example.test/source.mp4?token=SOURCE_SECRET";
sourceNode.type = "video/mp4";
hiddenVideo.append(sourceNode);
shadow.append(hiddenVideo);

const disconnected = new FakeElement("video", { id: "disconnected-video" }, { visible: false });
Object.assign(disconnected, { currentSrc: "https://media.example.test/disconnected.mp4", duration: 2 });

const nativeProgress = new FakeElement("progress", { id: "native-progress", "aria-label": "Upload bytes" });
Object.assign(nativeProgress, { value: 63, max: 100 });
document.body.append(nativeProgress);

const roleProgress = new FakeElement("div", {
  id: "role-progress",
  role: "progressbar",
  "aria-valuenow": "42",
  "aria-valuemax": "100",
  "aria-label": "Uploading video 42 percent",
}, { visible: false });
shadow.append(roleProgress);

for (let index = 0; index < 20; index++) {
  const progress = new FakeElement("progress", { id: "extra-native-" + index });
  Object.assign(progress, { value: index, max: 20 });
  document.body.append(progress);
  const bar = new FakeElement("div", {
    id: "extra-role-" + index, role: "progressbar",
    "aria-valuenow": String(index), "aria-valuemax": "20", "aria-label": "Transfer " + index,
  });
  shadow.append(bar);
}
for (let index = 0; index < 40; index++) {
  const video = new FakeElement("video", { id: "hidden-extra-" + index }, { visible: false });
  Object.assign(video, {
    currentSrc: index === 0 ? "data:video/mp4;base64,PRIVATE_MEDIA_BYTES" : "",
    duration: NaN, currentTime: 0, readyState: 0, networkState: 3,
    paused: true, ended: false, muted: true, controls: false,
    videoWidth: 0, videoHeight: 0, error: null,
  });
  shadow.append(video);
}

const timingEntries = [];
for (let index = 0; index < 70; index++) {
  let overrides = {};
  if (index === 10) overrides = { name: "https://media.example.test/upload.mp4?sig=SIGNED_QUERY_SECRET#SIGNED_FRAGMENT_SECRET" };
  if (index === 11) overrides = { name: "https://user:password@media.example.test/credential.mp4?token=CREDENTIAL_SECRET" };
  if (index === 12) overrides = { name: "data:video/mp4;base64,RESOURCE_BODY_PRIVATE" };
  if (index === 13) overrides = { name: "blob:https://example.test/video-id?token=BLOB_QUERY_SECRET" };
  if (index === 14) overrides = { transferSize: "1234", responseStatus: "202" };
  timingEntries.push(makeTiming(index, overrides));
}
const numericReads = [];
const timingView = new Proxy(timingEntries, {
  get(target, property, receiver) {
    if (typeof property === "string" && /^\d+$/.test(property)) numericReads.push(Number(property));
    return Reflect.get(target, property, receiver);
  },
});
let performanceReads = 0;
const performance = {
  getEntriesByType(type) {
    performanceReads += 1;
    assert.equal(type, "resource");
    return timingView;
  },
};
const context = vm.createContext({
  document,
  location: { href: "https://old.reddit.com/r/aigamedev/submit" },
  performance,
  URL,
  Element: FakeElement,
  HTMLElement,
  HTMLInputElement,
  HTMLTextAreaElement,
  HTMLSelectElement,
  HTMLAnchorElement,
  CSS: { escape: value => value },
  getComputedStyle: element => ({
    display: element.visible ? "block" : "none",
    visibility: element.visible ? "visible" : "hidden",
    opacity: "1",
  }),
  Date,
  Map,
  Set,
});
const pageSnapshot = vm.runInContext("(" + snapshotSource + ")", context);
const snapshot = pageSnapshot(20_000, 200);

assert.equal(snapshot.resourceTimings.length, 60, "only the last sixty ResourceTiming records are returned");
assert.equal(snapshot.resourceTimingsTruncated, true);
assert.deepEqual(numericReads, Array.from({ length: 60 }, (_, index) => index + 10),
  "the snapshot reads no more than the final sixty entries");
assert.equal(performanceReads, 1, "resource timing is sampled once per snapshot");
assert.equal(snapshot.resourceTimings[0].urlWithoutQuery, "https://media.example.test/upload.mp4");
assert.equal(snapshot.resourceTimings[0].startTime, 20);
assert.equal(snapshot.resourceTimings[0].duration, 60);
assert.equal(snapshot.resourceTimings[0].responseStatus, 200);
assert.equal(snapshot.resourceTimings[1].urlWithoutQuery, null, "credentials invalidate a resource URL");
assert.equal(snapshot.resourceTimings[2].urlWithoutQuery, null, "data URLs never expose payloads");
assert.equal(snapshot.resourceTimings[3].urlWithoutQuery, "blob:https://example.test/video-id");
assert.equal(snapshot.resourceTimings[4].transferSize, null, "non-numeric timing values are omitted");
assert.equal(snapshot.resourceTimings[4].responseStatus, null);

assert.equal(snapshot.videos.length, 32, "video readback has a fixed per-snapshot cap");
assert.equal(snapshot.videosTruncated, true);
const hidden = snapshot.videos.find(video => video.selector.endsWith("#hidden-video"));
assert.ok(hidden, "connected hidden video metadata remains visible to the snapshot");
assert.equal(hidden.visible, false);
assert.equal(hidden.currentSrcWithoutQuery, "https://media.example.test/stalled.mp4");
assert.equal(hidden.readyState, 1);
assert.equal(hidden.networkState, 2);
assert.equal(hidden.duration, null);
assert.equal(hidden.videoWidth, 0);
assert.equal(hidden.error.code, 4);
assert.equal(hidden.sources.length, 1);
assert.equal(hidden.sources[0].srcWithoutQuery, "https://media.example.test/source.mp4");
assert.equal(hidden.sources[0].mimeType, "video/mp4");
assert.ok(!snapshot.videos.some(video => video.selector.includes("disconnected-video")));

assert.equal(snapshot.progressIndicators.length, 32, "progress indicators are bounded");
assert.equal(snapshot.progressIndicatorsTruncated, true);
const native = snapshot.progressIndicators.find(progress => progress.selector.endsWith("#native-progress"));
assert.ok(native);
assert.equal(native.value, 63);
assert.equal(native.max, 100);
assert.equal(native.ariaLabel, "Upload bytes");
const role = snapshot.progressIndicators.find(progress => progress.selector.endsWith("#role-progress"));
assert.ok(role);
assert.equal(role.visible, false, "hidden progress state is still read passively");
assert.equal(role.value, 42);
assert.equal(role.max, 100);
assert.equal(role.ariaValueNow, "42");
assert.equal(role.ariaValueMax, "100");
assert.equal(role.ariaLabel, "Uploading video 42 percent");

const rendered = JSON.stringify(snapshot);
for (const secret of [
  "SECRET_QUERY", "SECRET_FRAGMENT", "SIGNED_QUERY_SECRET", "SIGNED_FRAGMENT_SECRET",
  "CREDENTIAL_SECRET", "BLOB_QUERY_SECRET", "VIDEO_SECRET", "HIDDEN_VIDEO_SECRET",
  "SOURCE_SECRET", "PRIVATE_MEDIA_BYTES", "RESOURCE_BODY_PRIVATE", "PRIVATE_MEDIA_ERROR_TEXT",
  "user:password",
]) assert.ok(!rendered.includes(secret), "snapshot must not reveal " + secret);
assert.equal(dispatchCount, 0, "snapshot dispatches no events or actions");
assert.equal(hidden.currentTime, 0, "snapshot does not seek media");
assert.equal(hidden.paused, true, "snapshot does not play media");
assert.equal(performanceReads, 1);
assert.match(source, /resourceTimingLimit = 60/);
assert.match(source, /roots\.length >= 512/);
assert.match(source, /entry\.depth >= 16/);
assert.match(source, /observedElements\.length >= 20000/);
assert.match(source, /LOADED_EXTENSION_BUILD_ID = "browser-video-file-upload-20261011\.4"/);

console.log("chrome-snapshot-media-diagnostics: bounds, privacy, and passive-read checks passed");

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Source-only fixtures. Never connects to a browser, profile, bridge or site.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(root, 'chrome-extension/service-worker.js'), 'utf8');
function extract(name) {
  const match = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(match, name + ' must be present');
  const end = source.indexOf('\n}', match.index);
  return source.slice(match.index, end + 2);
}
const actionSource = ['pageSnapshot', 'pageClick', 'pageFill', 'pageVideoFileTransfer']
  .map(extract).join('\n\n');
const results = [];
async function scenario(name, run) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message, stack: error.stack }); }
}
const plain = value => JSON.parse(JSON.stringify(value));
class FakeEvent {
  constructor(type, init = {}) { this.type = type; this.defaultPrevented = false; Object.assign(this, init); }
  preventDefault() { this.defaultPrevented = true; }
}
function* descendants(root) {
  const stack = [...root.children].reverse();
  while (stack.length) {
    const node = stack.pop();
    yield node;
    for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]);
  }
}
function simpleMatch(node, selector) {
  if (selector === ':disabled') return Boolean(node.disabled);
  if (selector.startsWith('a[href],button,input,textarea,select,')) {
    return ['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY'].includes(node.tagName)
      || node.isContentEditable || node.hasAttribute('role') || node.hasAttribute('tabindex');
  }
  if (selector === '[role="combobox"],[aria-haspopup]:not([aria-haspopup="false"])') {
    return node.getAttribute('role') === 'combobox'
      || Boolean(node.getAttribute('aria-haspopup') && node.getAttribute('aria-haspopup') !== 'false');
  }
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  const attribute = /^([\w-]+)?\[([\w-]+)=(.+)\]$/.exec(selector);
  if (attribute) {
    const wanted = attribute[3].startsWith('"') ? JSON.parse(attribute[3])
      : attribute[3].startsWith("'") ? attribute[3].slice(1, -1) : attribute[3];
    return (!attribute[1] || node.tagName.toLowerCase() === attribute[1])
      && node.getAttribute(attribute[2]) === wanted;
  }
  const ordinary = /^([\w-]+)(?::nth-of-type\((\d+)\))?$/.exec(selector);
  if (ordinary) {
    if (node.tagName.toLowerCase() !== ordinary[1]) return false;
    if (!ordinary[2]) return true;
    const siblings = node.parentNode.children.filter(child => child.tagName === node.tagName);
    return siblings.indexOf(node) + 1 === Number(ordinary[2]);
  }
  if (selector.includes(' > ')) {
    const parts = selector.split(' > ');
    let current = node;
    for (let index = parts.length - 1; index >= 0; index--) {
      if (!current || !simpleMatch(current, parts[index])) return false;
      current = current.parentElement;
    }
    return true;
  }
  if (selector === '*') return true;
  return false;
}
class FakeRoot {
  constructor(document, mode, host) {
    this.ownerDocument = document; this.mode = mode; this.host = host;
    this.children = []; this.activeElement = null; this.listeners = new Map();
    this.aliases = new Map(); this.queries = [];
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
      node.parentNode = this; node.ownerDocument = this.ownerDocument || this;
      this.children.push(node);
    }
  }
  querySelectorAll(selector) {
    this.queries.push(selector);
    if (this.aliases.has(selector)) return this.aliases.get(selector);
    return [...descendants(this)].filter(node => simpleMatch(node, selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getElementById(id) { return [...descendants(this)].find(node => node.id === id) || null; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
}
class FakeElement extends FakeRoot {
  constructor(tag = 'div', attrs = {}, text = '') {
    super(null);
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attributes = new Map(Object.entries(attrs));
    this.text = text; this.visible = true; this.disabled = false; this.readOnly = false;
    this.shadowRoot = null; this.parentNode = null; this.events = []; this.onEvent = null;
    this.focusCalls = 0; this.clickCalls = 0; this.scrollCalls = 0; this.isContentEditable = false;
    this.draggable = false;
  }
  get parentElement() { return this.parentNode instanceof FakeElement ? this.parentNode : null; }
  get id() { return this.getAttribute('id') || ''; }
  get isConnected() {
    const root = this.getRootNode();
    return root instanceof FakeDocument || Boolean(root.host?.isConnected);
  }
  getRootNode() {
    let root = this;
    while (root.parentNode) root = root.parentNode;
    return root;
  }
  get innerText() { return [this.text, ...this.children.filter(child => child.visible).map(child => child.innerText)].filter(Boolean).join('\n'); }
  get textContent() { return [this.text, ...this.children.map(child => child.textContent)].join(''); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  matches(selector) { return simpleMatch(this, selector); }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  attach(mode = 'open') {
    const shadow = new FakeRoot(this.ownerDocument, mode, this);
    if (mode === 'open') this.shadowRoot = shadow;
    return shadow;
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  getBoundingClientRect() {
    return { x: 10, y: 20, left: 10, top: 20, width: this.visible ? 300 : 0, height: this.visible ? 40 : 0 };
  }
  scrollIntoView() { this.scrollCalls++; }
  focus() {
    this.focusCalls++;
    let target = this, root = this.getRootNode();
    root.activeElement = target;
    while (root.host) {
      target = root.host; root = target.getRootNode(); root.activeElement = target;
    }
  }
  blur() { this.getRootNode().activeElement = null; }
  click() { this.clickCalls++; this.dispatchEvent(new FakeEvent('click', { bubbles: true, composed: true })); }
  dispatchEvent(event) {
    event.target = this; this.events.push(event);
    for (const callback of this.listeners.get(event.type) || []) callback(event);
    return this.onEvent?.(event) !== false;
  }
}
class FakeInput extends FakeElement {
  constructor(attrs = {}, type = 'text') {
    super('input', { ...attrs, type });
    this.type = type; this._value = ''; this._files = []; this.setterCalls = 0; this.fileSetterCalls = 0;
    this.accept = type === 'file' ? 'video/mp4,.mp4' : '';
    this.multiple = false; this.webkitdirectory = false; this.labels = [];
    this.selectionStart = 0; this.selectionEnd = 0;
  }
  get value() { return this._value; }
  set value(value) { this.setterCalls++; this._value = String(value); }
  get files() { return this._files; }
  set files(files) {
    this.fileSetterCalls++; this._files = files;
    this._value = files.length ? 'C:\\fakepath\\' + files[0].name : '';
  }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
}
class FakeTextarea extends FakeInput {
  constructor(attrs = {}) { super(attrs); this.tagName = 'TEXTAREA'; }
  get value() { return this._value; }
  set value(value) { this.setterCalls++; this._value = String(value); }
}
class FakeSelect extends FakeInput {}
class FakeAnchor extends FakeElement {}
class FakeDocument extends FakeRoot {
  constructor() {
    super(null); this.ownerDocument = this; this.title = 'Isolated shadow fixture'; this.walked = 0;
    this.documentElement = new FakeElement('html'); this.append(this.documentElement);
    this.body = new FakeElement('body'); this.documentElement.append(this.body);
    this.activeElement = this.body;
  }
  createTreeWalker(root) {
    const iterator = descendants(root);
    return { nextNode: () => { this.walked++; return iterator.next().value || null; } };
  }
  hasFocus() { return false; }
}
class FakeFile {
  constructor(parts, name, options = {}) {
    this.name = name; this.type = options.type || ''; this.lastModified = options.lastModified || 0;
    this.size = parts.reduce((total, part) => total + part.byteLength, 0);
  }
}
class FakeDataTransfer {
  constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; }
}
function fixture() {
  const document = new FakeDocument();
  const legacy = new FakeInput({ id: 'legacy' }); document.body.append(legacy);
  const host = new FakeElement('x-composer', { id: 'composer' }); document.body.append(host);
  const shadow = host.attach();
  const title = new FakeTextarea({ id: 'title', 'aria-label': 'Title' });
  const post = new FakeElement('button', { id: 'post' }, 'Post');
  const text = new FakeElement('p', {}, 'Ready to share the current development build');
  const uploadHost = new FakeElement('x-upload', { id: 'upload', 'data-max-file-size': '500000000' });
  shadow.append(title, post, text, uploadHost);
  const uploadRoot = uploadHost.attach();
  const input = new FakeInput({ id: 'video' }, 'file'); input.visible = false;
  uploadRoot.append(input);
  const context = vm.createContext({
    document, window: { document, innerWidth: 1200, innerHeight: 800, screenX: 0, screenY: 0 },
    location: { href: 'https://fixture.invalid/compose' },
    Element: FakeElement, HTMLElement: FakeElement, HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextarea, HTMLSelectElement: FakeSelect, HTMLAnchorElement: FakeAnchor,
    Event: FakeEvent, InputEvent: FakeEvent, FocusEvent: FakeEvent, KeyboardEvent: FakeEvent,
    MouseEvent: FakeEvent, PointerEvent: FakeEvent, File: FakeFile, DataTransfer: FakeDataTransfer,
    CSS: { escape: value => value }, URL, Date,
    crypto: crypto.webcrypto,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    getComputedStyle: node => ({ display: node.visible ? 'block' : 'none', visibility: 'visible', opacity: '1' }),
    setTimeout: (callback, timeout) => timeout > 10_000 ? null : setTimeout(callback, 0),
    clearTimeout,
    requestAnimationFrame: callback => setTimeout(callback, 0),
  });
  const actions = vm.runInContext(actionSource + '\n({pageSnapshot, pageClick, pageFill, pageVideoFileTransfer})', context);
  return { document, host, shadow, title, post, uploadHost, uploadRoot, input, legacy, context, ...actions };
}
const titleSelector = '#composer >>> #title';
const inputSelector = '#composer >>> #upload >>> #video';
function options() {
  return {
    tabId: 73, expectedDocumentId: 'fixture-document',
    expectedUrl: 'https://fixture.invalid/compose', deadlineMs: Date.now() + 10_000,
  };
}
function mp4() {
  const bytes = Buffer.alloc(40, 0x7d);
  bytes.writeUInt32BE(16, 0); bytes.write('ftyp', 4); bytes.write('isom', 8);
  bytes.writeUInt32BE(0, 12); bytes.writeUInt32BE(8, 16); bytes.write('moov', 20);
  bytes.writeUInt32BE(16, 24); bytes.write('mdat', 28);
  return bytes;
}
function metadata(bytes) {
  return { name: 'fixture.mp4', mimeType: 'video/mp4', size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), lastModified: 1000 };
}
async function beginAndChunk(f, id = 'shadow_video') {
  const bytes = mp4();
  await f.pageVideoFileTransfer('begin', inputSelector, id, metadata(bytes), options());
  await f.pageVideoFileTransfer('chunk', inputSelector, id, {
    index: 0, offset: 0, base64: bytes.toString('base64'),
  }, options());
  return bytes;
}

await scenario('snapshot-discovers-open-nested-controls-and-keeps-light-css-selectors', () => {
  const f = fixture();
  const snapshot = f.pageSnapshot(20_000, 200);
  assert.ok(snapshot.elements.some(item => item.selector === '#legacy'));
  assert.ok(snapshot.elements.some(item => item.selector === titleSelector && item.tag === 'textarea'));
  assert.ok(snapshot.elements.some(item => item.selector === '#composer >>> #post'));
  assert.equal(snapshot.fileInputs[0].selector, inputSelector);
  assert.equal(snapshot.fileInputs[0].visible, false, 'Hidden upload inputs remain observable');
  assert.ok(snapshot.bodyText.includes('Ready to share the current development build'));
  assert.equal(snapshot.openShadowRoots, 2);
  assert.equal(snapshot.openShadowTraversalTruncated, false);
  assert.equal(f.title.events.length + f.post.events.length + f.input.events.length, 0);
  assert.equal(f.document.activeElement, f.document.body, 'Passive snapshot must not focus anything');
});

await scenario('snapshot-generates-unique-sibling-paths-and-root-local-ids', () => {
  const f = fixture();
  const one = new FakeElement('button', {}, 'First');
  const two = new FakeElement('button', {}, 'Second');
  f.shadow.append(one, two);
  const otherHost = new FakeElement('x-other', { id: 'other' }); f.document.body.append(otherHost);
  const otherRoot = otherHost.attach(); otherRoot.append(new FakeTextarea({ id: 'title' }));
  const snapshot = f.pageSnapshot(20_000, 200);
  const second = snapshot.elements.find(item => item.text === 'Second');
  assert.equal(second.selector, '#composer >>> button:nth-of-type(3)');
  assert.ok(snapshot.elements.some(item => item.selector === titleSelector));
  assert.ok(snapshot.elements.some(item => item.selector === '#other >>> #title'));
});

await scenario('closed-roots-and-frame-documents-are-never-discovered-or-targeted', async () => {
  const f = fixture();
  const host = new FakeElement('x-closed', { id: 'closed' }); f.document.body.append(host);
  const closed = host.attach('closed');
  const hidden = new FakeElement('button', { id: 'private' }, 'CLOSED_CONTENT_CANARY'); closed.append(hidden);
  const frame = new FakeElement('iframe', { id: 'frame' });
  frame.contentDocument = new FakeDocument();
  frame.contentDocument.body.append(new FakeElement('button', {}, 'FRAME_CONTENT_CANARY'));
  f.document.body.append(frame);
  const snapshot = f.pageSnapshot(20_000, 200);
  assert.ok(!JSON.stringify(snapshot).includes('CLOSED_CONTENT_CANARY'));
  assert.ok(!JSON.stringify(snapshot).includes('FRAME_CONTENT_CANARY'));
  await assert.rejects(() => f.pageClick('#closed >>> #private'), error => error.code === 'CHROME_ELEMENT_NOT_FOUND');
  assert.equal(hidden.events.length, 0);
});

await scenario('fill-resolves-deep-focus-and-preserves-one-edit-with-no-submit', async () => {
  const f = fixture();
  const result = await f.pageFill(titleSelector, 'Native video announcement', false);
  assert.equal(result.filled, true);
  assert.equal(result.submissionRequested, false);
  assert.equal(f.title.value, 'Native video announcement');
  assert.equal(f.title.setterCalls, 1);
  assert.equal(f.document.activeElement, f.host);
  assert.equal(f.shadow.activeElement, f.title);
  assert.deepEqual(f.title.events.map(event => event.type), ['focus', 'focusin', 'beforeinput', 'input', 'change']);
  const snapshot = f.pageSnapshot(20_000, 200);
  assert.equal(snapshot.focusedElement.selector, titleSelector);
  assert.equal(snapshot.elements.find(item => item.selector === titleSelector).focused, true);
});

await scenario('click-supports-shadow-controls-with-one-activation-and-deep-focus', async () => {
  const direct = fixture();
  const result = await direct.pageClick('#composer >>> #post', { clickStrategy: 'dom-click' });
  assert.equal(result.clicked, true);
  assert.equal(direct.post.clickCalls, 1);
  assert.deepEqual(direct.post.events.map(event => event.type), ['click']);
  assert.equal(direct.post.focusCalls, 0);
  const adaptive = fixture();
  const pointer = await adaptive.pageClick('#composer >>> #post');
  assert.equal(pointer.clicked, true);
  assert.equal(pointer.focusEventFallbackUsed, true);
  assert.equal(adaptive.shadow.activeElement, adaptive.post);
  assert.equal(adaptive.post.events.filter(event => event.type === 'click').length, 1);
});

await scenario('literal-delimiters-in-css-attributes-remain-normal-selectors', async () => {
  const f = fixture();
  const literal = new FakeInput({ 'aria-label': 'before >>> after' }); f.document.body.append(literal);
  const css = 'input[aria-label="before >>> after"]';
  await f.pageFill(css, 'ordinary selector', false);
  assert.equal(literal.value, 'ordinary selector');
  assert.ok(f.document.queries.includes(css), 'The original CSS must reach the normal root unchanged');
  const nested = new FakeInput({ 'aria-label': 'before >>> after' }); f.shadow.append(nested);
  const shadowCss = '#composer >>> ' + css;
  await f.pageFill(shadowCss, 'inside root', false);
  assert.equal(nested.value, 'inside root');
  assert.equal(literal.value, 'ordinary selector');
});

await scenario('shadow-selector-ambiguity-empty-segments-and-depth-fail-before-actions', async () => {
  for (const kind of ['host', 'leaf', 'empty', 'depth']) {
    const f = fixture();
    let selector = titleSelector;
    if (kind === 'host') {
      const duplicate = new FakeElement('x-composer', { id: 'composer' }); f.document.body.append(duplicate);
      duplicate.attach().append(new FakeTextarea({ id: 'title' }));
    }
    if (kind === 'leaf') f.shadow.append(new FakeTextarea({ id: 'title' }));
    if (kind === 'empty') selector = '#composer >>>  >>> #title';
    if (kind === 'depth') selector = Array(18).fill('#composer').join(' >>> ');
    const expected = ['empty', 'depth'].includes(kind) ? 'CHROME_SELECTOR_INVALID' : 'CHROME_SELECTOR_AMBIGUOUS';
    await assert.rejects(() => f.pageFill(selector, 'must not write', false),
      error => error.code === expected && error.details.actionDispatched === false);
    await assert.rejects(() => f.pageClick(selector),
      error => error.code === expected && error.details.actionDispatched === false);
    assert.equal(f.title.value, '');
    assert.equal(f.title.events.length, 0);
  }
});

await scenario('shadow-file-picker-and-disabled-readonly-deadline-controls-stay-enforced', async () => {
  const file = fixture();
  await assert.rejects(() => file.pageClick(inputSelector), error => error.code === 'CHROME_FOREGROUND_REQUIRED');
  file.input.visible = true;
  await assert.rejects(() => file.pageFill(inputSelector, 'invalid', false), error => error.code === 'CHROME_FOREGROUND_REQUIRED');
  assert.equal(file.input.events.length, 0);
  for (const condition of ['disabled', 'readonly', 'expired']) {
    const f = fixture();
    f.title.disabled = condition === 'disabled';
    f.title.readOnly = condition === 'readonly';
    const code = { disabled: 'CHROME_ELEMENT_DISABLED', readonly: 'CHROME_ELEMENT_READ_ONLY',
      expired: 'CHROME_OPERATION_DEADLINE_EXCEEDED' }[condition];
    await assert.rejects(() => f.pageFill(titleSelector, 'must not write', false,
      condition === 'expired' ? { deadlineMs: Date.now() - 1 } : {}),
    error => error.code === code && error.details.actionDispatched === false);
    assert.equal(f.title.events.length, 0);
  }
});

await scenario('shadow-replacement-during-edit-or-pointer-dispatch-stops-without-replay', async () => {
  const f = fixture();
  const replacement = new FakeTextarea({ id: 'title' });
  f.title.onEvent = event => {
    if (event.type === 'beforeinput') { f.title.remove(); f.shadow.append(replacement); }
  };
  await assert.rejects(() => f.pageFill(titleSelector, 'must not land on replacement', false),
    error => error.code === 'CHROME_TARGET_CHANGED');
  assert.equal(f.title.setterCalls, 0);
  assert.equal(replacement.setterCalls, 0);
  assert.equal(replacement.events.length, 0);
  const clicked = fixture();
  const replacementPost = new FakeElement('button', { id: 'post' });
  clicked.post.onEvent = event => {
    if (event.type === 'pointerdown') { clicked.post.remove(); clicked.shadow.append(replacementPost); }
  };
  await assert.rejects(() => clicked.pageClick('#composer >>> #post'),
    error => error.code === 'CHROME_TARGET_CHANGED' && error.details.actionDispatched === true);
  assert.equal(clicked.post.events.filter(event => event.type === 'click').length, 0);
  assert.equal(replacementPost.events.length, 0);
});

await scenario('shadow-video-transfer-retains-document-binding-and-one-file-assignment', async () => {
  const f = fixture();
  const bytes = await beginAndChunk(f);
  const result = await f.pageVideoFileTransfer('commit', inputSelector, 'shadow_video', null, options());
  assert.equal(result.fileAssigned, true);
  assert.equal(result.fileRetained, true);
  assert.equal(result.file.size, bytes.length);
  assert.equal(f.input.fileSetterCalls, 1);
  assert.deepEqual(f.input.events.map(event => event.type), ['input', 'change']);
  assert.equal(f.input.events[0].composed, true);
  const snapshot = f.pageSnapshot(20_000, 200);
  assert.equal(snapshot.fileInputs[0].hasValue, true);
  assert.equal(snapshot.fileInputs[0].fileCount, 1);
  assert.deepEqual(plain(snapshot.fileInputs[0].selectedFiles), [
    { name: 'fixture.mp4', mimeType: 'video/mp4', size: 40 },
  ]);
  assert.ok(!JSON.stringify(snapshot).includes('fakepath'));
  assert.equal(snapshot.fileInputs[0].uploadLimits[0].dataMaxFileSize, '500000000');
});

await scenario('shadow-video-stale-input-host-or-document-never-selects-a-replacement', async () => {
  for (const change of ['input', 'host', 'document']) {
    const f = fixture();
    await beginAndChunk(f, 'stale_' + change);
    const replacement = new FakeInput({ id: 'video' }, 'file');
    if (change === 'input') { f.input.remove(); f.uploadRoot.append(replacement); }
    if (change === 'host') {
      f.uploadHost.remove();
      const replacementHost = new FakeElement('x-upload', { id: 'upload' }); f.shadow.append(replacementHost);
      replacementHost.attach().append(replacement);
    }
    const opts = options();
    if (change === 'document') opts.expectedDocumentId = 'different-document';
    await assert.rejects(() => f.pageVideoFileTransfer('commit', inputSelector, 'stale_' + change, null, opts),
      error => error.code === (change === 'document' ? 'CHROME_DOCUMENT_CHANGED' : 'CHROME_FILE_INPUT_REPLACED'));
    assert.equal(f.input.fileSetterCalls, 0);
    assert.equal(replacement.fileSetterCalls, 0);
    assert.equal(f.input.events.length + replacement.events.length, 0);
  }
});

await scenario('passive-video-readback-includes-readiness-and-strips-url-secrets-and-bytes', () => {
  const f = fixture();
  const player = new FakeElement('video', { id: 'preview' });
  Object.assign(player, {
    currentSrc: 'https://media.example.test/preview.mp4?signature=SECRET_TOKEN#private-fragment',
    src: '', duration: 51.5, currentTime: 1.25, readyState: 4, networkState: 1,
    paused: true, ended: false, muted: false, controls: true, videoWidth: 1920, videoHeight: 1080, error: null,
  });
  const alternate = new FakeElement('source');
  alternate.src = 'https://media.example.test/alternate.mp4?token=OTHER_SECRET';
  alternate.type = 'video/mp4'; player.append(alternate); f.uploadRoot.append(player);
  const poster = new FakeElement('img', { id: 'poster' });
  Object.assign(poster, {
    currentSrc: 'https://media.example.test/poster.jpg?signature=POSTER_SECRET',
    src: '', alt: 'Video poster', naturalWidth: 1920, naturalHeight: 1080, complete: true,
  });
  f.shadow.append(poster);
  const snapshot = f.pageSnapshot(20_000, 200);
  assert.equal(snapshot.images[0].currentSrc, 'https://media.example.test/poster.jpg');
  assert.equal(snapshot.images[0].currentSrcWithoutQuery, 'https://media.example.test/poster.jpg');
  const video = snapshot.videos[0];
  assert.equal(video.selector, '#composer >>> #upload >>> #preview');
  assert.equal(video.currentSrcWithoutQuery, 'https://media.example.test/preview.mp4');
  assert.equal(video.sources[0].srcWithoutQuery, 'https://media.example.test/alternate.mp4');
  assert.equal(video.duration, 51.5);
  assert.equal(video.readyState, 4);
  assert.equal(video.videoWidth, 1920);
  assert.equal(video.videoHeight, 1080);
  assert.equal(video.error, null);
  assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
  assert.ok(!JSON.stringify(snapshot).includes('private-fragment'));
  player.currentSrc = 'blob:https://fixture.invalid/local-preview?token=SECRET_TOKEN';
  assert.equal(f.pageSnapshot(20_000, 200).videos[0].currentSrcWithoutQuery,
    'blob:https://fixture.invalid/local-preview');
  player.currentSrc = 'data:video/mp4;base64,PRIVATE_MEDIA_BYTES';
  player.duration = NaN; player.error = { code: 4, message: 'PRIVATE_MESSAGE' };
  const unknown = f.pageSnapshot(20_000, 200).videos[0];
  assert.equal(unknown.currentSrcWithoutQuery, null);
  assert.equal(unknown.duration, null);
  assert.equal(unknown.error.code, 4);
  assert.ok(!JSON.stringify(unknown).includes('PRIVATE_'));
  assert.equal(player.events.length, 0);
});

await scenario('snapshot-root-depth-and-node-budgets-stop-with-explicit-truncation', () => {
  const many = fixture();
  for (let index = 0; index < 530; index++) {
    const host = new FakeElement('x-many', { id: 'many-' + index }); many.document.body.append(host);
    host.attach().append(new FakeElement('button', {}, 'bounded'));
  }
  const roots = many.pageSnapshot(20_000, 500);
  assert.equal(roots.openShadowRoots, 511);
  assert.equal(roots.openShadowTraversalTruncated, true);
  const deep = fixture();
  let parent = deep.shadow;
  for (let index = 0; index < 20; index++) {
    const host = new FakeElement('x-deep', { id: 'deep-' + index }); parent.append(host);
    parent = host.attach();
  }
  parent.append(new FakeElement('button', { id: 'beyond-limit' }, 'TOO_DEEP_CANARY'));
  const depth = deep.pageSnapshot(20_000, 500);
  assert.equal(depth.openShadowTraversalTruncated, true);
  assert.ok(!JSON.stringify(depth).includes('TOO_DEEP_CANARY'));
  const large = fixture();
  for (let index = 0; index < 20_050; index++) large.document.body.append(new FakeElement('div'));
  const nodes = large.pageSnapshot(100, 50);
  assert.equal(nodes.openShadowTraversalTruncated, true);
  assert.ok(large.document.walked <= 20_001);
});

await scenario('ordinary-css-click-and-visible-fill-selection-retain-existing-behavior', async () => {
  const f = fixture();
  const hidden = new FakeInput({ name: 'same' }); hidden.visible = false;
  const visible = new FakeInput({ name: 'same' }); f.document.body.append(hidden, visible);
  await f.pageFill('input[name="same"]', 'visible target', false);
  assert.equal(hidden.value, '');
  assert.equal(visible.value, 'visible target');
  const first = new FakeElement('button', { name: 'same' });
  const second = new FakeElement('button', { name: 'same' });
  f.document.body.append(first, second);
  await f.pageClick('button[name="same"]', { clickStrategy: 'dom-click' });
  assert.equal(first.clickCalls, 1);
  assert.equal(second.clickCalls, 0);
});

const admissionStart = source.indexOf('const ACTIVE_VIDEO_TRANSFER_STORAGE_PREFIX =');
const admissionEnd = source.indexOf('let nativeConnectionSequence =', admissionStart);
assert.ok(admissionStart >= 0 && admissionEnd > admissionStart);
function admissionFixture({ failSetOnce = false } = {}) {
  const stored = {};
  let peak = 0;
  const context = vm.createContext({
    Date, chrome: { storage: { session: {
      async get() { await new Promise(resolve => setImmediate(resolve)); return { ...stored }; },
      async set(values) {
        await new Promise(resolve => setImmediate(resolve));
        if (failSetOnce) { failSetOnce = false; throw new Error('Synthetic storage failure'); }
        Object.assign(stored, values); peak = Math.max(peak, Object.keys(stored).length);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
      },
    } } },
  });
  const api = vm.runInContext(source.slice(admissionStart, admissionEnd)
    + '\n({admitActiveVideoFileTransfer,clearActiveVideoFileTransfer,videoFileTransferStorageKey,'
    + 'reserveReload: () => { extensionReloadReserved = true; }})', context);
  return { ...api, stored, peak: () => peak };
}
await scenario('concurrent-video-admission-never-exceeds-two-and-recovers-after-limit', async () => {
  const f = admissionFixture();
  const keys = Array.from({ length: 6 }, (_, index) => f.videoFileTransferStorageKey(1, 'document', 'transfer-' + index));
  const results = await Promise.allSettled(keys.map(key => f.admitActiveVideoFileTransfer(key)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(results.filter(result => result.status === 'rejected'
    && result.reason.code === 'CHROME_VIDEO_FILE_TRANSFER_LIMIT').length, 4);
  assert.equal(f.peak(), 2);
  await f.clearActiveVideoFileTransfer(keys[0]);
  await f.admitActiveVideoFileTransfer(keys[5]);
  assert.equal(Object.keys(f.stored).length, 2);
  assert.equal(f.peak(), 2);
});
await scenario('failed-admission-does-not-poison-queue-or-reserve-capacity', async () => {
  const f = admissionFixture({ failSetOnce: true });
  const keys = [1, 2, 3].map(index => f.videoFileTransferStorageKey(1, 'document', 'transfer-' + index));
  const outcomes = await Promise.allSettled(keys.map(key => f.admitActiveVideoFileTransfer(key)));
  assert.equal(outcomes[0].status, 'rejected');
  assert.equal(outcomes.slice(1).every(result => result.status === 'fulfilled'), true);
  assert.equal(Object.keys(f.stored).length, 2);
  assert.equal(f.peak(), 2);
  const reload = admissionFixture(); reload.reserveReload();
  await assert.rejects(() => reload.admitActiveVideoFileTransfer(keys[0]),
    error => error.code === 'CHROME_EXTENSION_RELOAD_PENDING');
  assert.equal(Object.keys(reload.stored).length, 0);
});

console.log(JSON.stringify({
  passed: results.filter(result => result.passed).length, total: results.length,
  results, environment: 'source-only-dom-and-storage-fixtures',
}, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;

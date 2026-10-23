import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Explicit real-browser regression. Creates a disposable headless profile and
// uses only owned in-memory HTML. Never attaches to an existing browser/profile.
// MDB_BROWSER_TEST_PLAYWRIGHT points to a separately installed Playwright.
// MDB_BROWSER_TEST_BASELINE optionally points to the pre-patch worker source.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(root, 'chrome-extension/service-worker.js'), 'utf8');
const require = createRequire(import.meta.url);
const { chromium } = await import(process.env.MDB_BROWSER_TEST_PLAYWRIGHT || require.resolve('playwright'));
function extract(text, name) {
  const match = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(text);
  assert.ok(match, name);
  const end = text.indexOf('\n}', match.index);
  assert.ok(end > match.index);
  return text.slice(match.index, end + 2);
}
const production = ['pageSnapshot', 'pageClick'].map(name => extract(source, name)).join('\n');
const baseline = process.env.MDB_BROWSER_TEST_BASELINE
  ? extract(await fs.readFile(process.env.MDB_BROWSER_TEST_BASELINE, 'utf8'), 'pageSnapshot') : null;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-nonsemantic-test-'));
await fs.chmod(profile, 0o700);
const results = [];
let context;
let browserVersion;
let cleaned = false;
async function scenario(name, html, run) {
  const page = await context.newPage();
  try {
    await page.setContent('<!doctype html><meta charset="utf-8"><title>Owned control fixture</title>' + html);
    await page.addScriptTag({ content: production + '\nwindow.mdbFixture = { pageSnapshot, pageClick };' });
    const snapshot = (options = {}, maxElements = 200) => page.evaluate(
      ({ options, maxElements }) => window.mdbFixture.pageSnapshot(20000, maxElements, options), { options, maxElements });
    await run(page, snapshot);
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.message, stack: error.stack });
  } finally { await page.close(); }
}
const selectors = snapshot => snapshot.elements.map(element => element.selector);
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true, viewport: { width: 1200, height: 800 }, serviceWorkers: 'block', acceptDownloads: false,
  });
  await context.route('**/*', route => route.abort());
  browserVersion = context.browser()?.version() || 'unavailable';
  await scenario('opt-in-default-stays-byte-compatible-with-baseline', '<button id="native">Save</button><div id="card" style="cursor:pointer">Open settings</div>', async (page, snap) => {
    const current = await snap();
    assert.ok(!selectors(current).includes('#card'));
    assert.equal('nonsemanticDiscovery' in current, false);
    assert.deepEqual(await snap({ includeNonsemantic: false }), current);
    if (baseline) {
      const previous = await page.evaluate(text => (0, eval)('(' + text + ')')(20000, 200), baseline);
      assert.deepEqual(current, previous);
    }
  });
  await scenario('discovers-pointer-card-and-delegated-click-opens-panel-once', '<div id="trigger" style="cursor:pointer;padding:12px"><span id="trigger-label">When customer visits a page</span></div><div id="result">Closed</div><script>let clicks=0; document.querySelector("#trigger").addEventListener("click",()=>{document.querySelector("#result").textContent="Opened "+(++clicks);});</script>', async (page, snap) => {
    const result = await snap({ includeNonsemantic: true });
    const label = result.elements.find(element => element.text === 'When customer visits a page');
    assert.ok(label); assert.equal(label.discovery, 'nonsemantic'); assert.ok(label.interactionHints.includes('cursor-pointer'));
    assert.equal(await page.locator(label.selector).count(), 1);
    const action = await page.evaluate(async selector => window.mdbFixture.pageClick(selector), label.selector);
    assert.equal(action.clicked, true);
    assert.equal(await page.locator('#result').innerText(), 'Opened 1');
  });
  await scenario('href-less-anchor-and-custom-html-control-discovery', '<a id="rule" style="cursor:pointer">Add page rule</a><x-action id="custom" style="cursor:pointer">Custom settings</x-action>', async (page, snap) => {
    const result = await snap({ includeNonsemantic: true });
    assert.ok(selectors(result).includes('#rule')); assert.ok(selectors(result).includes('#custom'));
    assert.deepEqual(selectors(await snap({ textQuery: 'Add page rule' })), ['#rule']);
  });
  await scenario('text-query-finds-nonsemantic-label-without-pointer-or-role', '<div><div><span id="label">When customer\n visits a page</span></div></div><p>Different setting</p>', async (page, snap) => {
    const result = await snap({ textQuery: '  WHEN CUSTOMER visits A PAGE ' });
    assert.equal(result.elements.length, 1); assert.equal(result.elements[0].selector, '#label');
    assert.equal(result.elements[0].inferredInteractive, false);
    assert.equal(result.nonsemanticDiscovery.mode, 'exact-rendered-text');
  });
  await scenario('ambiguous-identical-labels-remain-separate-observed-targets', '<div id="first">Settings</div><div id="second">Settings</div>', async (page, snap) => {
    const result = await snap({ textQuery: 'settings' });
    assert.deepEqual(selectors(result), ['#first', '#second']);
  });
  await scenario('native-controls-preferred-over-their-child-labels', '<button id="native" style="cursor:pointer"><span id="child">Save</span></button>', async (page, snap) => {
    assert.deepEqual(selectors(await snap({ textQuery: 'save' })), ['#native']);
  });
  await scenario('hidden-transparent-inert-and-disabled-ancestors-excluded', '<div style="display:none"><span>Hidden target</span></div><div style="opacity:0"><span>Transparent target</span></div><div inert><span>Inert target</span></div><div aria-hidden="true"><span>ARIA hidden target</span></div><div aria-disabled="true"><span>Disabled target</span></div><div style="content-visibility:hidden"><span>Content hidden target</span></div><span style="pointer-events:none">Pointer disabled target</span>', async (page, snap) => {
    for (const textQuery of ['Hidden target', 'Transparent target', 'Inert target', 'ARIA hidden target', 'Disabled target', 'Content hidden target', 'Pointer disabled target'])
      assert.equal((await snap({ textQuery })).elements.length, 0, textQuery);
  });
  await scenario('open-shadow-label-resolves-and-clicks', '<x-fixture id="host"></x-fixture><div id="result">Closed</div><script>const s=document.querySelector("#host").attachShadow({mode:"open"});s.innerHTML="<div id=card style=cursor:pointer><span id=label>Shadow settings</span></div>";s.querySelector("#card").addEventListener("click",()=>document.querySelector("#result").textContent="Opened");</script>', async (page, snap) => {
    const result = await snap({ textQuery: 'Shadow settings' });
    assert.equal(result.elements.length, 1); assert.equal(result.elements[0].selector, '#host >>> #label');
    await page.evaluate(async selector => window.mdbFixture.pageClick(selector), result.elements[0].selector);
    assert.equal(await page.locator('#result').innerText(), 'Opened');
  });
  await scenario('closed-shadow-and-frame-content-not-traversed', '<x-fixture id="host"></x-fixture><iframe srcdoc="<div style=cursor:pointer>Frame private label</div>"></iframe><script>document.querySelector("#host").attachShadow({mode:"closed"}).innerHTML="<div style=cursor:pointer>Closed private label</div>";</script>', async (page, snap) => {
    for (const textQuery of ['Closed private label', 'Frame private label']) assert.equal((await snap({ textQuery })).elements.length, 0);
  });
  await scenario('no-handler-source-framework-property-or-password-leak', '<input id="password" type="password" value="fixture-secret-value"><div id="inline" onclick="/*fixture-secret-handler-source*/void 0">Open inline settings</div><div id="react" style="cursor:pointer">React setting</div><script>for(const p of ["onclick","__reactProps$fixture","__vue__"]){Object.defineProperty(document.querySelector("#react"),p,{get(){throw new Error("Framework state read");}});}</script>', async (page, snap) => {
    const result = await snap({ includeNonsemantic: true });
    assert.equal(result.elements.find(element => element.selector === '#password').value, '<redacted>');
    assert.ok(result.elements.find(element => element.selector === '#inline').interactionHints.includes('inline-click-attribute'));
    assert.ok(result.elements.find(element => element.selector === '#react'));
    assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  });
  await scenario('snapshot-is-passive-with-no-events-focus-or-mutation', '<input id="focused"><div id="card" style="cursor:pointer">Open settings</div>', async (page, snap) => {
    await page.evaluate(() => {
      document.querySelector('#focused').focus(); window.fixtureEvents = 0; window.fixtureMutations = 0;
      for (const name of ['click','focus','blur','input','change','invalid','pointerdown','mouseover']) document.addEventListener(name, () => window.fixtureEvents++, true);
      new MutationObserver(entries => window.fixtureMutations += entries.length).observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
    });
    await snap({ includeNonsemantic: true }); await snap({ textQuery: 'Open settings' });
    assert.deepEqual(await page.evaluate(() => ({events:window.fixtureEvents, mutations:window.fixtureMutations, focus:document.activeElement.id})), {events:0,mutations:0,focus:'focused'});
  });
  await scenario('extra-target-count-and-total-results-are-bounded', Array.from({length:250}, (_,i)=>'<div id="target'+i+'" style="cursor:pointer">Option '+i+'</div>').join(''), async (page, snap) => {
    const result = await snap({ includeNonsemantic: true }, 5);
    assert.equal(result.elements.length, 5); assert.equal(result.elementsTruncated, true); assert.equal(result.nonsemanticDiscovery.extraLimit, 5);
  });
  await scenario('scan-limit-is-reported-instead-of-a-false-complete-search', '<main>'+ '<div>Ordinary text</div>'.repeat(5100) + '<div id="late">Late target</div></main>', async (page, snap) => {
    const result = await snap({ textQuery: 'Late target' });
    assert.equal(result.nonsemanticDiscovery.inspectedElements, 5000); assert.equal(result.nonsemanticDiscovery.truncated, true); assert.equal(result.elementsTruncated, true);
  });
  await scenario('hidden-descendant-text-is-not-used-as-a-target-label', '<div id="card" style="cursor:pointer">Public label<span hidden>Private hidden label</span></div>', async (page, snap) => {
    const result = await snap({ includeNonsemantic: true });
    assert.equal(result.elements.find(element => element.selector === '#card').text, 'Public label');
    assert.equal((await snap({ textQuery: 'Private hidden label' })).elements.length, 0);
  });
} finally {
  await context?.close(); await fs.rm(profile, { recursive: true, force: true });
  cleaned = !(await fs.stat(profile).catch(() => null));
}
const report = { workerSha256: crypto.createHash('sha256').update(source).digest('hex'), browserVersion,
  environment: 'disposable-headless-profile-owned-in-memory-html-no-external-network', profileRemoved: cleaned,
  passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, results };
console.log(JSON.stringify(report, null, 2));
if (report.failed || !cleaned) process.exitCode = 1;

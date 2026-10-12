import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { TextDecoder, TextEncoder } from "node:util";
import { MAX_CHROME_CSV_FILE_BYTES, prepareChromeCsvFile } from "../lib/chrome-csv-file.mjs";
import { operationFingerprint, isReadOnlyChromeMethod } from "../lib/chrome-operation-registry.mjs";

// Uses only synthetic inputs in a private temporary directory and a VM.
// It does not access a provider, an owner browser/profile, or actual contact data.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mdb-csv-file-unit-")));
await fs.chmod(directory, 0o700);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const results = [];
async function scenario(name, run) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message, stack: error.stack }); }
}
async function write(name, bytes) {
  const localPath = path.join(directory, name);
  await fs.writeFile(localPath, bytes, { mode: 0o600 });
  return localPath;
}
const basicBytes = Buffer.from("email,first_name\nalice@example.invalid,Alice\n", "utf8");
const csv = bytes => ({ name: "reviewed.csv", mimeType: "text/csv", size: bytes.length,
  sha256: hash(bytes), lastModified: 1_728_000_000_000, base64: bytes.toString("base64") });

class FakeEvent {
  constructor(type, init = {}) { this.type = type; this.defaultPrevented = false; Object.assign(this, init); }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
}
class FakeFile {
  constructor(parts, name, options = {}) {
    this.bytes = Buffer.concat(parts.map(part => Buffer.from(part)));
    this.name = name; this.type = options.type || ""; this.lastModified = options.lastModified || 0;
    this.size = this.bytes.length;
  }
}
class FakeDataTransfer {
  constructor() { this._files = []; this.items = { add: file => this._files.push(file) }; }
  get files() { return this._files; }
}
class FakeInputElement {
  constructor() {
    this.type = "file"; this.accept = ".csv,text/csv"; this.disabled = false; this.webkitdirectory = false;
    this.isConnected = true; this.ownerDocument = null; this.events = []; this.setterCalls = 0;
    this._files = []; this.attributes = new Map(); this.focusCalls = 0; this.clickCalls = 0; this.pickerCalls = 0;
    this.form = { submitCalls: 0, requestSubmitCalls: 0,
      submit() { this.submitCalls++; }, requestSubmit() { this.requestSubmitCalls++; } };
  }
  get files() { return this._files; }
  set files(value) { this.setterCalls++; this._files = value; }
  matches(selector) { return selector === ":disabled" && this.disabled; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  dispatchEvent(event) { this.events.push(event); this.onEvent?.(event); return !event.defaultPrevented; }
  focus() { this.focusCalls++; }
  click() { this.clickCalls++; }
  showPicker() { this.pickerCalls++; }
}
let actionSource;
function fixture() {
  const input = new FakeInputElement();
  let matches = [input];
  const document = { documentElement: {}, visibilityState: "hidden", hasFocus: () => false,
    querySelectorAll(selector) { if (selector === "[") throw new Error("Invalid selector"); return selector === "#csv" ? matches : []; },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; } };
  input.ownerDocument = document;
  const location = { href: "https://example.invalid/import" };
  const window = { document, focusCalls: 0, focus() { this.focusCalls++; } };
  const state = { beforeDigest: null, networkCalls: 0 };
  const context = vm.createContext({ document, window, location, HTMLInputElement: FakeInputElement,
    Event: FakeEvent, File: FakeFile, DataTransfer: FakeDataTransfer, TextDecoder, TextEncoder,
    crypto: { subtle: { async digest(...args) { await state.beforeDigest?.(); return crypto.webcrypto.subtle.digest(...args); } } },
    atob: value => Buffer.from(value, "base64").toString("binary"),
    btoa: value => Buffer.from(value, "binary").toString("base64"), Date,
    fetch: () => { state.networkCalls++; throw new Error("Direct network is forbidden in fixture"); } });
  const action = vm.runInContext("(" + actionSource + ")", context);
  return { input, document, location, window, state,
    replace(next = new FakeInputElement()) { matches = [next]; next.ownerDocument = document; return next; },
    setMatches(next) { matches = next; for (const value of next) value.ownerDocument = document; },
    invoke(file = csv(basicBytes), options = {}, selector = "#csv") {
      return action(selector, file, { expectedUrl: "https://example.invalid/import",
        deadlineMs: Date.now() + 5000, errorsAsData: true, ...options });
    } };
}
const errorOf = result => result?.__mdbPageActionError;
function noImplicitAction(f) {
  assert.equal(f.input.focusCalls, 0); assert.equal(f.input.clickCalls, 0); assert.equal(f.input.pickerCalls, 0);
  assert.equal(f.input.form.submitCalls, 0); assert.equal(f.input.form.requestSubmitCalls, 0);
  assert.equal(f.window.focusCalls, 0); assert.equal(f.state.networkCalls, 0);
}
function notAssigned(f, result, code) {
  assert.ok(errorOf(result), "Rejected CSV must return a typed failure");
  if (code) assert.equal(errorOf(result).code, code);
  assert.equal(errorOf(result).actionDispatched, false);
  assert.equal(f.input.setterCalls, 0); assert.deepEqual(f.input.events, []);
  noImplicitAction(f);
}

try {
  const localPath = await write("reviewed.csv", basicBytes);
  const valid = { localPath, mimeType: "text/csv", expectedSha256: hash(basicBytes) };
  await scenario("prepare-preserves-exact-reviewed-bytes", async () => {
    assert.equal(MAX_CHROME_CSV_FILE_BYTES, 1_048_576);
    const prepared = await prepareChromeCsvFile(valid);
    assert.equal(prepared.name, "reviewed.csv"); assert.equal(prepared.mimeType, "text/csv");
    assert.equal(prepared.size, basicBytes.length); assert.equal(prepared.sha256, hash(basicBytes));
    assert.deepEqual(Buffer.from(prepared.base64, "base64"), basicBytes);
    assert.equal(prepared.lastModified, Math.trunc((await fs.stat(localPath)).mtimeMs));
    assert.ok(!JSON.stringify(prepared).includes(directory), "Wire metadata must not include the source path");
  });
  const richBytes = Buffer.from('\uFEFFemail,first_name,note\r\nalice@example.invalid,Alice,"comma, quote ""and"" newline\ninside"\r\nborge@example.invalid,Børge,hello\r\n', "utf8");
  await scenario("utf8-bom-crlf-quoted-comma-quote-newline-preserved", async () => {
    const file = await prepareChromeCsvFile({ ...valid, localPath: await write("unicode.csv", richBytes), expectedSha256: hash(richBytes) });
    assert.deepEqual(Buffer.from(file.base64, "base64"), richBytes);
  });
  async function rejected(name, args) {
    await scenario(name, async () => {
      await assert.rejects(() => prepareChromeCsvFile(args), error => {
        assert.match(error.code || "", /^CHROME_CSV_/);
        const publicError = JSON.stringify({ message: error.message, details: error.details });
        assert.ok(!publicError.includes(directory)); assert.ok(!publicError.includes(basicBytes.toString("base64")));
        return true;
      });
    });
  }
  await rejected("relative-path", { ...valid, localPath: "reviewed.csv" });
  await rejected("non-normalized-path", { ...valid, localPath: directory + "/./reviewed.csv" });
  await rejected("missing-file", { ...valid, localPath: path.join(directory, "missing.csv") });
  await rejected("directory", { ...valid, localPath: directory });
  await fs.symlink(localPath, path.join(directory, "linked.csv"));
  await rejected("symlink-file", { ...valid, localPath: path.join(directory, "linked.csv") });
  await fs.symlink(directory, path.join(directory, "linked-directory"));
  await rejected("symlink-parent", { ...valid, localPath: path.join(directory, "linked-directory", "reviewed.csv") });
  await rejected("mime-required", { ...valid, mimeType: undefined });
  await rejected("mime-plain-text-not-enabled", { ...valid, mimeType: "text/plain" });
  await rejected("mime-active-format-not-enabled", { ...valid, mimeType: "text/html" });
  await rejected("extension-required", { ...valid, localPath: await write("reviewed.txt", basicBytes) });
  await rejected("digest-required", { ...valid, expectedSha256: undefined });
  await rejected("digest-malformed", { ...valid, expectedSha256: "not-a-hash" });
  await rejected("digest-mismatch", { ...valid, expectedSha256: "0".repeat(64) });
  for (const [name, bytes] of [
    ["empty", Buffer.alloc(0)],
    ["invalid-utf8", Buffer.from([0x65, 0x2c, 0x66, 0x0a, 0xc3, 0x28, 0x2c, 0x61])],
    ["nul-binary", Buffer.from("a,b\nx,\0\n")],
    ["control-binary", Buffer.from("a,b\nx,\x01\n")],
    ["unclosed-quoted-field", Buffer.from('a,b\nx,"never closed\n')],
    ["unescaped-quote", Buffer.from('a,b\nx,un"quoted\n')],
    ["different-record-width", Buffer.from("a,b\nx,y,z\n")],
  ]) await rejected(name, { ...valid, localPath: await write(name + ".csv", bytes), expectedSha256: hash(bytes) });
  await scenario("exact-cap-fits-native-envelope", async () => {
    const bytes = Buffer.from("a,b\n" + "x".repeat(MAX_CHROME_CSV_FILE_BYTES - 7) + ",y\n");
    assert.equal(bytes.length, MAX_CHROME_CSV_FILE_BYTES);
    const prepared = await prepareChromeCsvFile({ ...valid, localPath: await write("exact-cap.csv", bytes), expectedSha256: hash(bytes) });
    assert.ok(Buffer.byteLength(JSON.stringify({ method: "tabs.setFileInput", args: { tabId: 1, selector: "#csv", expectedDocumentId: "test_document", file: prepared } })) < 2 * 1024 * 1024);
  });
  const oversized = Buffer.from("a,b\n" + "x".repeat(MAX_CHROME_CSV_FILE_BYTES - 6) + ",y\n");
  await rejected("one-byte-over-cap", { ...valid, localPath: await write("over-cap.csv", oversized), expectedSha256: hash(oversized) });

  const worker = await fs.readFile(path.join(root, "chrome-extension/service-worker.js"), "utf8");
  const start = worker.indexOf("async function pageSetFileInput(");
  const end = worker.indexOf("\n}", start);
  assert.ok(start >= 0 && end > start, "Extract actual production file selection action");
  actionSource = worker.slice(start, end + 2);
  for (const accept of [".csv", "text/csv", "text/*", ".CSV, application/pdf", ""]) {
    await scenario("dom-accept-" + (accept || "empty"), async () => {
      const f = fixture(); f.input.accept = accept;
      const result = await f.invoke();
      assert.ok(!errorOf(result), JSON.stringify(errorOf(result)));
      assert.equal(result.fileAssigned, true); assert.equal(result.fileRetained, true);
      assert.equal(result.fileCount, 1); assert.equal(result.trusted, false); assert.equal(result.applicationAccepted, null);
      assert.equal(f.input.setterCalls, 1); assert.deepEqual(f.input.events.map(e => e.type), ["input", "change"]);
      assert.ok(f.input.events.every(e => e.cancelable === false && e.defaultPrevented === false));
      assert.deepEqual(f.input.files[0].bytes, basicBytes); noImplicitAction(f);
    });
  }
  for (const accept of ["image/*", "image/png", ".xlsx", "application/pdf"]) {
    await scenario("dom-reject-accept-" + accept, async () => {
      const f = fixture(); f.input.accept = accept;
      notAssigned(f, await f.invoke(), "CHROME_FILE_ACCEPT_MISMATCH");
    });
  }
  await scenario("dom-utf8-multiline-file", async () => {
    const f = fixture(); const result = await f.invoke(csv(richBytes));
    assert.ok(!errorOf(result), JSON.stringify(errorOf(result)));
    assert.deepEqual(f.input.files[0].bytes, richBytes); noImplicitAction(f);
  });
  for (const [name, configure, code] of [
    ["disabled", f => { f.input.disabled = true; }, "CHROME_ELEMENT_DISABLED"],
    ["aria-disabled", f => { f.input.attributes.set("aria-disabled", "true"); }, "CHROME_ELEMENT_DISABLED"],
    ["directory", f => { f.input.webkitdirectory = true; }, "CHROME_FILE_DIRECTORY_UNSUPPORTED"],
    ["wrong-input-type", f => { f.input.type = "text"; }, "CHROME_ELEMENT_NOT_FILE_INPUT"],
    ["ambiguous", f => { f.setMatches([f.input, new FakeInputElement()]); }, "CHROME_FILE_INPUT_AMBIGUOUS"],
    ["stale-url", f => { f.location.href += "?changed"; }, "CHROME_DOCUMENT_CHANGED"],
  ]) await scenario("dom-reject-" + name, async () => {
    const f = fixture(); configure(f); notAssigned(f, await f.invoke(), code);
  });
  await scenario("dom-reject-nonempty-csv-without-overwrite", async () => {
    const f = fixture(); const previous = new FakeFile([Buffer.from("private previous")], "previous.csv", { type: "text/csv" });
    f.input._files = [previous]; notAssigned(f, await f.invoke());
    assert.equal(f.input.files[0], previous);
  });
  await scenario("dom-no-repeat-after-successful-csv-selection", async () => {
    const f = fixture(); assert.ok(!errorOf(await f.invoke()));
    const repeated = await f.invoke();
    assert.ok(errorOf(repeated)); assert.equal(errorOf(repeated).actionDispatched, false);
    assert.equal(f.input.setterCalls, 1); assert.deepEqual(f.input.events.map(e => e.type), ["input", "change"]);
    noImplicitAction(f);
  });
  await scenario("dom-replaced-during-digest-never-redirects", async () => {
    const f = fixture(); let replacement;
    f.state.beforeDigest = () => { replacement = f.replace(); };
    notAssigned(f, await f.invoke(), "CHROME_FILE_INPUT_REPLACED");
    assert.equal(replacement.setterCalls, 0); assert.deepEqual(replacement.events, []);
  });
  for (const timing of ["sync", "microtask"]) await scenario("dom-replaced-after-input-" + timing, async () => {
    const f = fixture(); let replacement;
    f.input.onEvent = event => { if (event.type === "input") {
      if (timing === "sync") replacement = f.replace();
      else Promise.resolve().then(() => { replacement = f.replace(); });
    } };
    const result = await f.invoke();
    assert.equal(errorOf(result)?.code, "CHROME_FILE_INPUT_REPLACED");
    assert.equal(f.input.setterCalls, 1); assert.deepEqual(f.input.events.map(e => e.type), ["input"]);
    assert.equal(replacement.setterCalls, 0); assert.deepEqual(replacement.events, []); noImplicitAction(f);
  });
  await scenario("dom-accept-changed-after-input-stops-change", async () => {
    const f = fixture(); f.input.onEvent = event => { if (event.type === "input") f.input.accept = "image/*"; };
    const result = await f.invoke(); assert.equal(errorOf(result)?.code, "CHROME_FILE_ACCEPT_MISMATCH");
    assert.equal(f.input.setterCalls, 1); assert.deepEqual(f.input.events.map(e => e.type), ["input"]); noImplicitAction(f);
  });
  await scenario("dom-deadline-before-assignment", async () => {
    const f = fixture(); notAssigned(f, await f.invoke(csv(basicBytes), { deadlineMs: 1 }), "CHROME_OPERATION_DEADLINE_EXCEEDED");
  });
  for (const [name, mutate] of [
    ["hash", f => ({ ...f, sha256: "0".repeat(64) })],
    ["base64", f => ({ ...f, base64: "<invalid>" })],
    ["size", f => ({ ...f, size: f.size + 1 })],
    ["mime", f => ({ ...f, mimeType: "text/html" })],
    ["extension", f => ({ ...f, name: "reviewed.html" })],
    ["binary", () => csv(Buffer.from("a,b\nx,\0\n"))],
    ["invalid-utf8", () => csv(Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0xc3, 0x28, 0x2c, 0x79]))],
  ]) await scenario("dom-reject-payload-" + name, async () => {
    const f = fixture(); notAssigned(f, await f.invoke(mutate(csv(basicBytes))), "CHROME_FILE_PAYLOAD_INVALID");
  });
  await scenario("image-accept-and-existing-selection-semantics-unchanged", async () => {
    const f = fixture(); f.input.accept = "image/*";
    const previous = new FakeFile([Buffer.from("prior")], "previous.png", { type: "image/png" });
    f.input._files = [previous];
    const png = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(png);
    png.write("IHDR", 12, "ascii"); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
    const image = { ...csv(png), name: "reviewed.png", mimeType: "image/png" };
    const result = await f.invoke(image);
    assert.ok(!errorOf(result), JSON.stringify(errorOf(result)));
    assert.equal(f.input.setterCalls, 1); assert.equal(f.input.files[0].type, "image/png");
    assert.notEqual(f.input.files[0], previous); noImplicitAction(f);
  });
  await scenario("csv-filled-during-hash-cannot-overwrite-new-selection", async () => {
    const f = fixture(); let previous;
    f.state.beforeDigest = () => {
      previous = new FakeFile([Buffer.from("arrived while hashing")], "new-selection.csv", { type: "text/csv" });
      f.input._files = [previous];
    };
    notAssigned(f, await f.invoke()); assert.equal(f.input.files[0], previous);
  });
  await scenario("worker-csv-keeps-url-grant-and-document-pin", async () => {
    const routeStart = worker.indexOf('    case "tabs.setFileInput": {');
    const routeEnd = worker.indexOf('\n    case "tabs.videoFileBegin":', routeStart);
    assert.ok(routeStart >= 0 && routeEnd > routeStart, "Extract actual file-input dispatch case");
    const route = worker.slice(routeStart, routeEnd);
    const executions = []; let allowed = true; let grantChecks = 0;
    const dispatch = vm.runInNewContext("(async function(message, args) { const compiled = []; switch (message.method) { " + route + " } })", {
      async getApprovedTab(tabId) {
        grantChecks++; if (!allowed) { const error = new Error("Synthetic URL grant rejected"); error.code = "CHROME_URL_NOT_APPROVED"; throw error; }
        return { id: tabId, url: "https://example.invalid/import" };
      },
      observeTabAction: async (tabId, action) => action(),
      executeInTab: async (...args) => { executions.push(args); return { selected: true }; },
      pageSetFileInput: () => {},
    });
    const message = { method: "tabs.setFileInput", deadlineMs: Date.now() + 5000 };
    const args = { tabId: 17, selector: "#csv", expectedDocumentId: "fresh_document_1", file: csv(basicBytes) };
    await dispatch(message, args);
    assert.equal(grantChecks, 1); assert.equal(executions.length, 1);
    assert.equal(executions[0][0], 17); assert.equal(executions[0][2][2].expectedUrl, "https://example.invalid/import");
    assert.equal(executions[0][4].expectedDocumentId, "fresh_document_1");
    assert.equal(executions[0][4].includeDocumentIdentity, true);
    await assert.rejects(() => dispatch(message, { ...args, expectedDocumentId: "" }),
      error => error.code === "CHROME_DOCUMENT_CHANGED" && error.details.actionDispatched === false);
    assert.equal(executions.length, 1, "Invalid document ID cannot inject");
    allowed = false;
    await assert.rejects(() => dispatch(message, args), error => error.code === "CHROME_URL_NOT_APPROVED");
    assert.equal(executions.length, 1, "Denied grant cannot inject");
  });
  await scenario("csv-fingerprint-binds-file-document-and-url-grants", async () => {
    const request = { method: "tabs.setFileInput", args: { tabId: 1, selector: "#csv", expectedDocumentId: "test_document", file: csv(basicBytes) },
      allowedUrlPatterns: ["https://example.invalid/*"] };
    const fingerprint = operationFingerprint(request); assert.equal(isReadOnlyChromeMethod(request.method), false);
    for (const altered of [
      { ...request, args: { ...request.args, expectedDocumentId: "other_document" } },
      { ...request, args: { ...request.args, file: csv(Buffer.from("email,name\nbob@example.invalid,Bob\n")) } },
      { ...request, allowedUrlPatterns: ["https://another.invalid/*"] },
    ]) assert.notEqual(operationFingerprint(altered), fingerprint);
  });
  await scenario("csv-audit-redacts-both-public-and-wire-sensitive-data", async () => {
    const source = await fs.readFile(path.join(root, "bridge.mjs"), "utf8");
    const start = source.indexOf("function auditSafeArguments("), end = source.indexOf("\n}", start);
    const audit = vm.runInNewContext("(" + source.slice(start, end + 2) + ")", { Buffer, crypto,
      MAX_CHROME_CSV_FILE_BYTES, MAX_CHROME_IMAGE_FILE_BYTES: 1024 * 1024, MAX_CHROME_VIDEO_FILE_BYTES: 128 * 1024 * 1024 });
    const file = csv(basicBytes);
    for (const args of [
      { tab_id: 1, selector: "#csv", expected_document_id: "test_document", local_path: localPath,
        mime_type: "text/csv", expected_sha256: file.sha256, operation_id: "csv_test_123" },
      { tabId: 1, selector: "#csv", expectedDocumentId: "test_document", file },
    ]) {
      const redacted = audit("chrome_set_file_input", args); const rendered = JSON.stringify(redacted);
      assert.equal(redacted.mime_type, "text/csv"); assert.equal(redacted.expected_sha256, file.sha256);
      assert.ok(!rendered.includes(directory)); assert.ok(!rendered.includes(file.base64));
      assert.ok(!rendered.includes("alice@example.invalid")); assert.ok(!Object.hasOwn(redacted, "file"));
    }
  });
} finally {
  await fs.rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: results.filter(r => r.passed).length, total: results.length, results,
    temporaryDirectoryRemoved: true, providerAccessed: false, browserAccessed: false }, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;

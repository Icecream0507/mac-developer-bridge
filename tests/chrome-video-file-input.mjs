import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "chrome-extension", "service-worker.js"), "utf8");
const start = source.indexOf("async function pageVideoFileTransfer(");
const end = source.indexOf("\nasync function pageClick(", start);
assert.ok(start >= 0 && end > start, "the isolated video transfer function should be extractable");
const transferSource = source.slice(start, end);

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.defaultPrevented = false;
    Object.assign(this, init);
  }
}
class FakeFile {
  constructor(parts, name, options = {}) {
    this.name = name;
    this.type = options.type || "";
    this.lastModified = options.lastModified || 0;
    this.size = parts.reduce((total, part) => total + part.byteLength, 0);
  }
}
class FakeDataTransfer {
  constructor() {
    this._files = [];
    this.items = { add: file => this._files.push(file) };
  }
  get files() { return this._files; }
}
class FakeInputElement {
  constructor() {
    this.type = "file";
    this.accept = "video/mp4,.mp4";
    this.disabled = false;
    this.webkitdirectory = false;
    this.isConnected = true;
    this.ownerDocument = null;
    this.events = [];
    this.setterCalls = 0;
    this._files = [];
  }
  get files() { return this._files; }
  set files(value) { this.setterCalls += 1; this._files = value; }
  matches(selector) { return selector === ":disabled" && this.disabled; }
  getAttribute(name) { return name === "aria-disabled" && this.disabled ? "true" : null; }
  hasAttribute() { return false; }
  dispatchEvent(event) { this.events.push(event.type); return true; }
}

function fixture() {
  const input = new FakeInputElement();
  let matches = [input];
  const document = {
    documentElement: {},
    querySelectorAll: selector => selector === "#video" ? matches : [],
  };
  input.ownerDocument = document;
  const window = { document };
  const context = vm.createContext({
    document,
    window,
    location: { href: "https://old.reddit.com/r/aigamedev/submit" },
    HTMLInputElement: FakeInputElement,
    Event: FakeEvent,
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    crypto: crypto.webcrypto,
    atob: value => Buffer.from(value, "base64").toString("binary"),
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    setTimeout: () => 1,
    clearTimeout: () => {},
    Date,
  });
  const transfer = vm.runInContext("(" + transferSource + ")", context);
  return {
    input,
    replaceTarget(next) { matches = [next]; next.ownerDocument = document; },
    invoke(phase, transferId, payload) {
      return transfer(phase, "#video", transferId, payload, {
        tabId: 8,
        expectedDocumentId: "fixture_document_1",
        expectedUrl: "https://old.reddit.com/r/aigamedev/submit",
        deadlineMs: Date.now() + 60_000,
        errorsAsData: true,
      });
    },
  };
}

function makeMp4(size) {
  assert.ok(size >= 32);
  const bytes = Buffer.alloc(size, 0x5a);
  bytes.writeUInt32BE(16, 0);
  bytes.write("ftyp", 4, "ascii");
  bytes.write("isom", 8, "ascii");
  bytes.writeUInt32BE(0, 12);
  bytes.writeUInt32BE(8, 16);
  bytes.write("moov", 20, "ascii");
  bytes.writeUInt32BE(size - 24, 24);
  bytes.write("mdat", 28, "ascii");
  return bytes;
}
function metadataFor(bytes, name = "reviewed.mp4", sha = crypto.createHash("sha256").update(bytes).digest("hex")) {
  return {
    name,
    mimeType: "video/mp4",
    size: bytes.length,
    sha256: sha,
    lastModified: 1_728_000_000_000,
  };
}
function errorCode(result) { return result?.__mdbPageActionError?.code; }
function base64(bytes) { return Buffer.from(bytes).toString("base64"); }

{
  // Exercise the maximum chunk and a one-byte tail to catch protocol boundary errors.
  const f = fixture();
  const bytes = makeMp4(256 * 1024 + 1);
  const file = metadataFor(bytes);
  const id = "boundary_transfer_1";
  const begin = await f.invoke("begin", id, file);
  assert.equal(begin.state, "begun");
  assert.equal(begin.transferId, id);
  assert.equal(begin.size, bytes.length);
  assert.equal(begin.receivedBytes, 0);
  assert.equal(begin.actionDispatched, false);
  assert.equal(f.input.setterCalls, 0);
  assert.deepEqual(f.input.events, []);

  const first = await f.invoke("chunk", id, {
    index: 0, offset: 0, base64: base64(bytes.subarray(0, 256 * 1024)),
  });
  assert.equal(first.index, 0);
  assert.equal(first.nextIndex, 1);
  assert.equal(first.receivedBytes, 256 * 1024);
  assert.equal(first.actionDispatched, false);
  assert.equal(f.input.setterCalls, 0);
  assert.deepEqual(f.input.events, []);

  const last = await f.invoke("chunk", id, {
    index: 1, offset: 256 * 1024, base64: base64(bytes.subarray(256 * 1024)),
  });
  assert.equal(last.index, 1);
  assert.equal(last.nextIndex, 2);
  assert.equal(last.receivedBytes, bytes.length);
  assert.equal(last.actionDispatched, false);
  assert.equal(f.input.setterCalls, 0);
  assert.deepEqual(f.input.events, []);

  const committed = await f.invoke("commit", id, null);
  assert.equal(committed.state, "committed");
  assert.equal(committed.fileAssigned, true);
  assert.equal(committed.inputEventDispatched, true);
  assert.equal(committed.changeEventDispatched, true);
  assert.equal(committed.fileRetained, true);
  assert.equal(committed.fileCount, 1);
  assert.equal(committed.actionDispatched, true);
  assert.equal(committed.file.name, file.name);
  assert.equal(committed.file.mimeType, file.mimeType);
  assert.equal(committed.file.size, file.size);
  assert.equal(committed.file.sha256, file.sha256);
  assert.equal(f.input.setterCalls, 1, "commit performs exactly one FileList assignment");
  assert.deepEqual(f.input.events, ["input", "change"], "commit emits one input/change pair");
  assert.doesNotMatch(JSON.stringify(committed), /base64|local_path|localPath|\/Users\//);

  const duplicate = await f.invoke("commit", id, null);
  assert.equal(errorCode(duplicate), "CHROME_VIDEO_FILE_TRANSFER_NOT_FOUND");
  assert.equal(f.input.setterCalls, 1, "a repeated terminal request must not replay assignment");
  assert.deepEqual(f.input.events, ["input", "change"]);
}

{
  const f = fixture();
  const bytes = makeMp4(40);
  const id = "out_of_order_1";
  await f.invoke("begin", id, metadataFor(bytes));
  const rejected = await f.invoke("chunk", id, { index: 1, offset: 0, base64: base64(bytes) });
  assert.equal(errorCode(rejected), "CHROME_VIDEO_FILE_CHUNK_INVALID");
  const afterRelease = await f.invoke("chunk", id, { index: 0, offset: 0, base64: base64(bytes) });
  assert.equal(errorCode(afterRelease), "CHROME_VIDEO_FILE_TRANSFER_NOT_FOUND");
  assert.equal(f.input.setterCalls, 0);
  assert.deepEqual(f.input.events, []);
}

{
  const f = fixture();
  const bytes = makeMp4(40);
  const id = "hash_mismatch_1";
  await f.invoke("begin", id, metadataFor(bytes, "reviewed.mp4", "0".repeat(64)));
  await f.invoke("chunk", id, { index: 0, offset: 0, base64: base64(bytes) });
  const rejected = await f.invoke("commit", id, null);
  assert.equal(errorCode(rejected), "CHROME_VIDEO_FILE_HASH_MISMATCH");
  assert.equal(f.input.setterCalls, 0);
  assert.deepEqual(f.input.events, []);
}

{
  const f = fixture();
  const bytes = makeMp4(40);
  bytes.write("not!", 4, "ascii");
  const id = "signature_mismatch_1";
  await f.invoke("begin", id, metadataFor(bytes));
  await f.invoke("chunk", id, { index: 0, offset: 0, base64: base64(bytes) });
  const rejected = await f.invoke("commit", id, null);
  assert.equal(errorCode(rejected), "CHROME_VIDEO_FILE_SIGNATURE_MISMATCH");
  assert.equal(f.input.setterCalls, 0);
  assert.deepEqual(f.input.events, []);
}

{
  const f = fixture();
  const bytes = makeMp4(40);
  const id = "replacement_target_1";
  await f.invoke("begin", id, metadataFor(bytes));
  const replacement = new FakeInputElement();
  f.replaceTarget(replacement);
  const rejected = await f.invoke("chunk", id, { index: 0, offset: 0, base64: base64(bytes) });
  assert.equal(errorCode(rejected), "CHROME_FILE_INPUT_REPLACED");
  assert.equal(f.input.setterCalls, 0);
  assert.equal(replacement.setterCalls, 0, "the replacement input must never be used");
  assert.deepEqual(f.input.events, []);
  assert.deepEqual(replacement.events, []);
}

{
  const f = fixture();
  const bytes = makeMp4(40);
  const id = "abort_transfer_1";
  await f.invoke("begin", id, metadataFor(bytes));
  const result = await f.invoke("abort", id, null);
  assert.equal(result.state, "aborted");
  assert.equal(result.aborted, true);
  assert.equal(result.receivedBytes, 0);
  assert.equal(result.actionDispatched, false);
  assert.equal(f.input.setterCalls, 0);
  assert.deepEqual(f.input.events, []);
}

// Test the exact audit projection used by the bridge, for both public arguments
// and internal chunk arguments. Neither paths, names, nor file bytes/base64 survive.
const bridgeSource = await fs.readFile(path.join(root, "bridge.mjs"), "utf8");
const auditStart = bridgeSource.indexOf("function auditSafeArguments(");
const auditEnd = bridgeSource.indexOf("\n}", auditStart) + 2;
assert.ok(auditStart >= 0 && auditEnd > auditStart);
const auditSafeArguments = vm.runInNewContext(
  "(" + bridgeSource.slice(auditStart, auditEnd) + ")",
  { Buffer, crypto, MAX_CHROME_VIDEO_FILE_BYTES: 128 * 1024 * 1024 },
);
const sensitiveCanaries = {
  localPath: "/Users/alexanderbenz/private/video_canary.mp4",
  name: "private_video_name_canary.mp4",
  base64: "BASE64_VIDEO_CANARY",
  bytes: "RAW_VIDEO_BYTES_CANARY",
};
const publicAudit = auditSafeArguments("chrome_set_video_input", {
  tab_id: 8, selector: "#video", expected_document_id: "fixture_document_1",
  operation_id: "operation_video_123", local_path: sensitiveCanaries.localPath,
  mime_type: "video/mp4", expected_sha256: "a".repeat(64),
  file: { name: sensitiveCanaries.name, mimeType: "video/mp4", size: 1024, bytes: sensitiveCanaries.bytes },
});
const chunkAudit = auditSafeArguments("chrome_set_video_input", {
  tabId: 8, selector: "#video", expectedDocumentId: "fixture_document_1",
  operation_id: "operation_video_123", index: 3, offset: 786432,
  localPath: sensitiveCanaries.localPath, base64: sensitiveCanaries.base64,
  file: { name: sensitiveCanaries.name, mimeType: "video/mp4", size: 1024, bytes: sensitiveCanaries.bytes },
});
for (const audit of [publicAudit, chunkAudit]) {
  const rendered = JSON.stringify(audit);
  for (const secret of Object.values(sensitiveCanaries)) assert.ok(!rendered.includes(secret));
  assert.ok(rendered.includes("[REDACTED_LOCAL_VIDEO_PATH]"));
  assert.ok(rendered.includes("[REDACTED_VIDEO_BYTES]"));
}
assert.equal(publicAudit.video_size, 1024);
assert.equal(chunkAudit.chunk_index, 3);

// Exercise the reload branch itself with the reload operation's own lease,
 // another active operation, an in-flight video transfer, and an idle success.
const reloadStart = source.indexOf('if (message.method === "extension.reload") {');
const reloadEnd = source.indexOf('if (message.method === "workspace.status")', reloadStart);
assert.ok(reloadStart >= 0 && reloadEnd > reloadStart);
const reloadBranch = source.slice(reloadStart, reloadEnd);
async function runReload({ active = [], transfers = 0 } = {}) {
  let reloadCalls = 0;
  const scheduled = [];
  const context = vm.createContext({
    extensionReloadReserved: false,
    nativeOperations: new Map(active.map(operation => [operation.id, operation])),
    countActiveVideoFileTransfers: async () => transfers,
    VERSION: "fixture",
    chrome: { runtime: { id: "fixture-extension", reload: () => { reloadCalls += 1; } } },
    setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return 1; },
  });
  const invoke = vm.runInContext(
    "(async function(message) { " + reloadBranch + " return null; })",
    context,
  );
  return { invoke, context, scheduled, reloadCalls: () => reloadCalls };
}
{
  const ownReload = { id: "reload_operation_1", state: "dispatched" };
  const f = await runReload({ active: [ownReload] });
  const result = await f.invoke({ method: "extension.reload", id: ownReload.id });
  assert.equal(result.reloading, true, "the reload request may ignore its own dispatched lease");
  assert.equal(f.context.extensionReloadReserved, true);
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.scheduled[0].delay, 100);
  assert.equal(f.reloadCalls(), 0, "reload is scheduled only after the success result");
}
{
  const f = await runReload({ active: [{ id: "unrelated_operation_1", state: "dispatched" }] });
  await assert.rejects(
    () => f.invoke({ method: "extension.reload", id: "reload_operation_2" }),
    error => error.code === "CHROME_EXTENSION_BUSY" && error.details.activeOperationCount === 1,
  );
  assert.equal(f.context.extensionReloadReserved, false);
  assert.equal(f.scheduled.length, 0);
}
{
  const f = await runReload({ transfers: 1 });
  await assert.rejects(
    () => f.invoke({ method: "extension.reload", id: "reload_operation_3" }),
    error => error.code === "CHROME_EXTENSION_BUSY" && error.details.activeVideoTransferCount === 1,
  );
  assert.equal(f.context.extensionReloadReserved, false, "a refused reload releases its reservation");
  assert.equal(f.scheduled.length, 0);
}
{
  const f = await runReload();
  f.context.extensionReloadReserved = true;
  await assert.rejects(
    () => f.invoke({ method: "extension.reload", id: "reload_operation_4" }),
    error => error.code === "CHROME_EXTENSION_RELOAD_PENDING",
  );
  assert.equal(f.scheduled.length, 0);
}

assert.match(source, /const MAX_ACTIVE_VIDEO_FILE_TRANSFERS = 2;/);
assert.match(source, /activeVideoTransferCount >= MAX_ACTIVE_VIDEO_FILE_TRANSFERS/);
assert.match(source, /extensionReloadReserved = true;/);
assert.match(source, /countActiveVideoFileTransfers\(\)/);
assert.match(source, /LOADED_EXTENSION_BUILD_ID = "browser-video-file-upload-20261011\.3"/);
assert.match(source, /selector.length > 10000/);
for (const phase of ["Begin", "Chunk", "Commit", "Abort"]) {
  assert.ok(source.includes('case "tabs.videoFile' + phase + '":'));
}
console.log("chrome-video-file-input: 11 scenarios passed");

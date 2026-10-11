import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CHROME_VIDEO_CHUNK_BYTES } from '../lib/chrome-video-file.mjs';
import { transferChromeVideoFile } from '../lib/chrome-video-upload.mjs';

// Stubbed callback only: no browser, bridge connection, filesystem fixtures,
// owner media, upload, input assignment, or network access.
const results = [];
const methods = {
  begin: 'tabs.videoFileBegin',
  chunk: 'tabs.videoFileChunk',
  commit: 'tabs.videoFileCommit',
  abort: 'tabs.videoFileAbort',
};
const binding = {
  tabId: 73,
  selector: 'input[type="file"][data-test="native-video"]',
  expectedDocumentId: 'document-for-upload-unit-test',
  operationId: 'reviewed-video-selection-public-id',
};
const privatePath = '/private/fixture-source/do-not-return/native-video.mp4';
const secretMarker = 'private-video-payload-do-not-return';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function makeFile(size) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index & 255;
  if (size > 521 + secretMarker.length) bytes.write(secretMarker, 521, 'utf8');
  return {
    name: 'reviewed-video.mp4', mimeType: 'video/mp4',
    size, sha256: sha256(bytes), lastModified: 1720000000123,
    bytes,
    // This extra caller field must not cross the transfer boundary.
    localPath: privatePath,
  };
}
function fileMetadata(file) {
  const { name, mimeType, size, sha256, lastModified } = file;
  return { name, mimeType, size, sha256, lastModified };
}
function assertClean(value) {
  const seen = new Set();
  const inspect = item => {
    if (typeof item === 'string') {
      assert.ok(!item.includes(privatePath), 'Returned metadata must omit private paths');
      assert.ok(!item.includes(secretMarker), 'Returned metadata must omit media content');
      assert.ok(!item.includes(Buffer.from(secretMarker).toString('base64')),
        'Returned metadata must omit encoded media content');
    }
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    assert.equal(Buffer.isBuffer(item) || ArrayBuffer.isView(item), false,
      'Returned metadata must not contain raw binary values');
    for (const [key, child] of Object.entries(item)) {
      assert.ok(!['bytes', 'base64', 'localPath', 'sourcePath', 'path'].includes(key),
        'Returned metadata must not contain a payload/path field: ' + key);
      inspect(child);
    }
  };
  inspect(value);
}
function errorWith(code) {
  const error = new Error('Synthetic transfer failure');
  error.code = code;
  return error;
}
async function scenario(name, run) {
  try {
    await run();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.message, stack: error.stack });
  }
}
async function rejectWith(promise, code, exactError) {
  let observed;
  await assert.rejects(promise, error => {
    observed = error;
    assert.equal(error.code, code);
    if (exactError) assert.equal(error, exactError, 'Cleanup must preserve the primary failure');
    assertClean({ message: error.message, details: error.details });
    return true;
  });
  return observed;
}
async function withClock(run, customRead) {
  const originalNow = Date.now;
  const clock = { now: 1_000_000, reads: 0 };
  Date.now = () => {
    clock.reads++;
    return customRead ? customRead(clock) : clock.now;
  };
  try {
    return await run(clock);
  } finally {
    Date.now = originalNow;
  }
}
async function boundedWait(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// This peer independently reconstructs the binary stream and checks all
// indices/offsets/boundaries before acknowledging. Hooks inject failures or
// hold an ACK; they do not change the production transfer implementation.
function createPeer(file, { before, after, reply } = {}) {
  const calls = [];
  const parts = [];
  let transferId;
  let receivedBytes = 0;
  let began = false;
  const call = async (method, args, options) => {
    const record = { method, args, options };
    calls.push(record);
    assert.equal(args.tabId, binding.tabId);
    assert.equal(args.selector, binding.selector);
    assert.equal(args.expectedDocumentId, binding.expectedDocumentId);
    assert.equal(typeof args.transferId, 'string');
    assert.ok(args.transferId.length > 0 && args.transferId.length <= 128);
    transferId ??= args.transferId;
    assert.equal(args.transferId, transferId, 'Every phase must use one transfer ID');
    assert.equal(typeof options.operationId, 'string');
    assert.ok(options.operationId.length > 0);
    assert.ok(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0,
      'No phase may receive an expired or nonfinite timeout');
    if (before) await before(record);
    let response;
    if (method === methods.begin) {
      assert.equal(began, false, 'Begin must not be retried');
      assert.deepEqual(args.file, fileMetadata(file));
      assertClean(args);
      began = true;
      response = {
        transferId, state: 'begun', size: file.size,
        receivedBytes: 0, actionDispatched: false,
      };
    } else if (method === methods.chunk) {
      assert.equal(began, true, 'Chunks require a successful begin');
      assert.equal(args.index, parts.length, 'Chunk indices must be contiguous');
      assert.equal(args.offset, receivedBytes, 'Byte offsets must be contiguous');
      assert.equal(typeof args.base64, 'string');
      const decoded = Buffer.from(args.base64, 'base64');
      assert.equal(decoded.toString('base64'), args.base64, 'Base64 must be canonical');
      assert.equal(decoded.length, Math.min(CHROME_VIDEO_CHUNK_BYTES, file.size - receivedBytes));
      assert.equal(Buffer.compare(decoded, file.bytes.subarray(receivedBytes, receivedBytes + decoded.length)), 0,
        'A chunk must preserve every reviewed byte');
      assert.ok(Buffer.byteLength(JSON.stringify({ method, args, options }), 'utf8') + 16 * 1024 < 1024 * 1024,
        'A chunk envelope must fit the native host-to-extension message limit');
      assert.equal(Object.hasOwn(args, 'file'), false, 'Chunks must not duplicate the full file');
      assert.equal(Object.hasOwn(args, 'localPath'), false);
      parts.push(decoded);
      receivedBytes += decoded.length;
      response = {
        transferId, index: args.index, receivedBytes,
        nextIndex: args.index + 1, actionDispatched: false,
      };
    } else if (method === methods.commit) {
      assert.equal(began, true);
      assert.equal(receivedBytes, file.size);
      assert.equal(sha256(Buffer.concat(parts)), file.sha256,
        'Commit must follow a complete, exact reconstruction');
      assertClean(args);
      response = {
        transferId, state: 'committed', fileAssigned: true,
        file: { name: file.name, mimeType: file.mimeType, size: file.size, sha256: file.sha256 },
        inputEventDispatched: true, changeEventDispatched: true,
        fileRetained: true, fileCount: 1, trusted: false, applicationAccepted: null,
        actionDispatched: true, tabId: binding.tabId, documentId: binding.expectedDocumentId,
        frameId: 0, targetTabId: binding.tabId, targetDocumentId: binding.expectedDocumentId,
        _background: { focusPolicy: 'background-only', provider: 'unit-test-stub' },
      };
    } else if (method === methods.abort) {
      assertClean(args);
      response = { transferId, aborted: true, receivedBytes: 0, actionDispatched: false };
    } else {
      throw new Error('Unexpected transfer method: ' + method);
    }
    if (reply) response = await reply(record, response);
    if (after) await after(record, response);
    return response;
  };
  return {
    call, calls, parts,
    count: method => calls.filter(item => item.method === method).length,
    get transferId() { return transferId; },
  };
}
function transfer(file, peer, options = {}) {
  return transferChromeVideoFile({ file, ...binding, call: peer.call, ...options });
}
function assertAbortedOnce(peer) {
  assert.equal(peer.count(methods.abort), 1, 'Failed staging must receive one cleanup attempt');
  assert.equal(peer.count(methods.commit), 0, 'A staging failure must not attempt selection');
  assert.equal(peer.calls.at(-1).method, methods.abort);
  assert.equal(peer.calls.at(-1).options.timeoutMs, 1_000,
    'Cleanup has a separate bounded budget even after transfer expiry');
}
function assertNoReplayAfterCommit(peer) {
  assert.equal(peer.count(methods.begin), 1);
  assert.equal(peer.count(methods.commit), 1, 'The side-effect phase must never be replayed');
  assert.equal(peer.count(methods.abort), 0, 'Uncertain selection must not be aborted');
  assert.equal(peer.calls.at(-1).method, methods.commit);
}

await scenario('exact-chunk-boundaries-order-reconstruction-and-public-commit-id', async () => {
  for (const size of [
    1, CHROME_VIDEO_CHUNK_BYTES - 1, CHROME_VIDEO_CHUNK_BYTES,
    CHROME_VIDEO_CHUNK_BYTES + 1, CHROME_VIDEO_CHUNK_BYTES * 5 + 173,
  ]) {
    const file = makeFile(size);
    const peer = createPeer(file);
    const result = await transfer(file, peer);
    const count = Math.ceil(size / CHROME_VIDEO_CHUNK_BYTES);
    assert.deepEqual(peer.calls.map(item => item.method),
      [methods.begin, ...Array(count).fill(methods.chunk), methods.commit]);
    assert.equal(Buffer.compare(Buffer.concat(peer.parts), file.bytes), 0);
    assert.equal(result.transferredBytes, size);
    assert.equal(result.chunkCount, count);
    assert.equal(result.transferId, peer.transferId);
    assert.deepEqual(result.file, {
      name: file.name, mimeType: file.mimeType, size, sha256: file.sha256,
    });
    assert.equal(peer.calls.at(-1).options.operationId, binding.operationId,
      'Only commit uses the caller original operation ID');
    for (const record of peer.calls.slice(0, -1)) {
      assert.notEqual(record.options.operationId, binding.operationId);
    }
    assertClean(result);
  }
});

await scenario('waits-for-each-ack-before-sending-the-next-chunk', async () => {
  const file = makeFile(CHROME_VIDEO_CHUNK_BYTES * 2 + 19);
  let release;
  let reached;
  const gate = new Promise(resolve => { release = resolve; });
  const paused = new Promise(resolve => { reached = resolve; });
  const peer = createPeer(file, {
    before: async record => {
      if (record.method === methods.chunk && record.args.index === 0) {
        reached();
        await gate;
      }
    },
  });
  const pending = transfer(file, peer);
  try {
    await boundedWait(paused, 'the first held chunk');
    await Promise.resolve();
    assert.deepEqual(peer.calls.map(item => item.method), [methods.begin, methods.chunk],
      'No additional chunk or commit may be sent before the current ACK');
  } finally {
    release();
  }
  await boundedWait(pending, 'the acknowledged transfer');
  assert.equal(peer.count(methods.chunk), 3);
});

await scenario('internal-operation-ids-are-bounded-stable-and-do-not-embed-the-public-id', async () => {
  const file = makeFile(CHROME_VIDEO_CHUNK_BYTES + 7);
  const operationId = 'public-op-with-private-context-' + 'context/'.repeat(100);
  const first = createPeer(file);
  const second = createPeer(file);
  await transfer(file, first, { operationId });
  await transfer(file, second, { operationId });
  assert.notEqual(first.transferId, second.transferId, 'Independent invocations need distinct staging IDs');
  const stagingIds = peer => peer.calls.filter(record => record.method !== methods.commit)
    .map(record => record.options.operationId);
  assert.deepEqual(stagingIds(first), stagingIds(second),
    'Stable phase IDs must be reproducible from the caller operation ID');
  assert.equal(new Set(stagingIds(first)).size, stagingIds(first).length);
  for (const id of stagingIds(first)) {
    assert.ok(id.length <= 80, 'Internal IDs must remain bounded even for a long public ID');
    assert.ok(!id.includes('private-context') && !id.includes('context/'));
  }
  assert.equal(first.calls.at(-1).options.operationId, operationId);
  const different = createPeer(file);
  await transfer(file, different, { operationId: operationId + '-different' });
  assert.notEqual(stagingIds(different)[0], stagingIds(first)[0]);
});

await scenario('returned-metadata-strips-payloads-and-extra-transport-fields', async () => {
  const file = makeFile(1_111);
  const peer = createPeer(file, {
    reply: (record, response) => record.method !== methods.commit ? response : ({
      ...response,
      bytes: file.bytes, base64: file.bytes.toString('base64'), localPath: privatePath,
      file: { ...response.file, bytes: file.bytes, localPath: privatePath, name: 'unexpected.mp4' },
      _background: {
        ...response._background, localPath: privatePath, bytes: file.bytes,
        debug: { sourcePath: privatePath },
      },
      unexpected: { payload: file.bytes, path: privatePath },
    }),
  });
  const result = await transfer(file, peer);
  assertClean(result);
  assert.equal(result.file.name, file.name, 'Returned filename must come from reviewed metadata');
  assert.equal(result.documentId, binding.expectedDocumentId);
  assert.equal(result.targetDocumentId, binding.expectedDocumentId);
  assert.equal(result.actionDispatched, true);
  assert.equal(result._background.focusPolicy, 'background-only');
});

await scenario('malformed-background-provider-cannot-smuggle-private-payloads', async () => {
  const file = makeFile(1_113);
  const peer = createPeer(file, {
    reply: (record, response) => record.method !== methods.commit ? response : ({
      ...response,
      _background: { provider: { localPath: privatePath, bytes: file.bytes } },
    }),
  });
  const result = await transfer(file, peer);
  assertClean(result);
});

await scenario('begin-transport-failure-aborts-uncertain-staging-without-retry', async () => {
  const file = makeFile(19);
  const original = errorWith('UNIT_BEGIN_RESPONSE_LOST');
  const peer = createPeer(file, {
    before: record => { if (record.method === methods.begin) throw original; },
  });
  await rejectWith(transfer(file, peer), original.code, original);
  assertAbortedOnce(peer);
  assert.deepEqual(peer.calls.map(item => item.method), [methods.begin, methods.abort]);
});

await scenario('chunk-transport-failure-stops-at-the-failed-chunk-and-aborts', async () => {
  for (const failedIndex of [0, 1]) {
    const file = makeFile(CHROME_VIDEO_CHUNK_BYTES * 2 + 41);
    const original = errorWith('UNIT_CHUNK_RESPONSE_LOST');
    const peer = createPeer(file, {
      before: record => {
        if (record.method === methods.chunk && record.args.index === failedIndex) throw original;
      },
    });
    await rejectWith(transfer(file, peer), original.code, original);
    assertAbortedOnce(peer);
    assert.equal(peer.count(methods.chunk), failedIndex + 1);
  }
});

await scenario('invalid-begin-acknowledgements-abort-before-any-chunk', async () => {
  for (const mutation of [
    () => undefined,
    response => ({ ...response, transferId: 'a-different-transfer' }),
    response => ({ ...response, receivedBytes: 1 }),
    response => ({ ...response, receivedBytes: '0' }),
  ]) {
    const file = makeFile(19);
    const peer = createPeer(file, {
      reply: (record, response) => record.method === methods.begin ? mutation(response) : response,
    });
    await rejectWith(transfer(file, peer), 'CHROME_VIDEO_ACK_MISMATCH');
    assertAbortedOnce(peer);
    assert.equal(peer.count(methods.chunk), 0);
  }
});

await scenario('invalid-chunk-acknowledgements-never-advance-or-commit', async () => {
  for (const mutation of [
    () => null,
    response => ({ ...response, transferId: 'another-transfer' }),
    response => ({ ...response, receivedBytes: response.receivedBytes - 1 }),
    response => ({ ...response, receivedBytes: String(response.receivedBytes) }),
    response => ({ ...response, index: response.index + 1 }),
    response => ({ ...response, index: String(response.index) }),
    response => ({ ...response, nextIndex: response.index }),
    response => ({ ...response, nextIndex: undefined }),
  ]) {
    const file = makeFile(CHROME_VIDEO_CHUNK_BYTES + 19);
    const peer = createPeer(file, {
      reply: (record, response) => record.method === methods.chunk ? mutation(response) : response,
    });
    await rejectWith(transfer(file, peer), 'CHROME_VIDEO_ACK_MISMATCH');
    assertAbortedOnce(peer);
    assert.equal(peer.count(methods.chunk), 1);
  }
});

await scenario('abort-failure-never-masks-the-original-staging-error', async () => {
  const file = makeFile(19);
  const original = errorWith('UNIT_PRIMARY_FAILURE');
  const peer = createPeer(file, {
    before: record => {
      if (record.method === methods.begin) throw original;
      if (record.method === methods.abort) throw errorWith('UNIT_CLEANUP_FAILURE');
    },
  });
  await rejectWith(transfer(file, peer), original.code, original);
  assertAbortedOnce(peer);
});

await scenario('abort-operation-id-is-stable-and-separate-from-other-phases', async () => {
  const file = makeFile(19);
  const original = errorWith('UNIT_STAGING_FAILED');
  const make = () => createPeer(file, {
    before: record => { if (record.method === methods.chunk) throw original; },
  });
  const first = make();
  const second = make();
  await rejectWith(transfer(file, first), original.code, original);
  await rejectWith(transfer(file, second), original.code, original);
  assertAbortedOnce(first);
  assertAbortedOnce(second);
  const abortId = first.calls.at(-1).options.operationId;
  assert.equal(abortId, second.calls.at(-1).options.operationId);
  assert.notEqual(abortId, binding.operationId);
  assert.ok(abortId.length <= 80);
  assert.equal(new Set(first.calls.map(item => item.options.operationId)).size, first.calls.length);
});

await scenario('all-phases-share-one-deadline-and-default-to-45-seconds', async () => {
  await withClock(async clock => {
    const start = clock.now;
    const file = makeFile(CHROME_VIDEO_CHUNK_BYTES + 19);
    const expectedBudgets = [45_000, 44_970, 44_940, 44_910];
    const peer = createPeer(file, {
      before: record => {
        assert.equal(record.options.timeoutMs, start + 45_000 - clock.now);
      },
      after: () => { clock.now += 30; },
    });
    await transfer(file, peer);
    assert.deepEqual(peer.calls.map(item => item.options.timeoutMs), expectedBudgets);
  });
});

await scenario('custom-timeout-budget-is-not-reset-between-phases', async () => {
  await withClock(async clock => {
    const file = makeFile(CHROME_VIDEO_CHUNK_BYTES + 19);
    const peer = createPeer(file, { after: () => { clock.now += 7; } });
    await transfer(file, peer, { timeoutMs: 100 });
    assert.deepEqual(peer.calls.map(item => item.options.timeoutMs), [100, 93, 86, 79]);
  });
});

await scenario('expired-transfer-after-begin-or-chunk-cleans-up-before-further-dispatch', async () => {
  for (const expiryPhase of [methods.begin, methods.chunk]) {
    await withClock(async clock => {
      const file = makeFile(CHROME_VIDEO_CHUNK_BYTES + 19);
      const peer = createPeer(file, {
        after: record => { if (record.method === expiryPhase) clock.now += 100; },
      });
      await rejectWith(transfer(file, peer, { timeoutMs: 100 }), 'CHROME_VIDEO_TRANSFER_TIMEOUT');
      assertAbortedOnce(peer);
      assert.equal(peer.count(methods.chunk), expiryPhase === methods.begin ? 0 : 1);
    });
  }
});

await scenario('expiry-after-final-ack-aborts-without-attempting-commit', async () => {
  await withClock(async clock => {
    const file = makeFile(19);
    const peer = createPeer(file, {
      after: record => { if (record.method === methods.chunk) clock.now += 100; },
    });
    await rejectWith(transfer(file, peer, { timeoutMs: 100 }), 'CHROME_VIDEO_TRANSFER_TIMEOUT');
    assertAbortedOnce(peer);
    assert.equal(peer.count(methods.chunk), 1);
  });
});

await scenario('deadline-crossing-cannot-suppress-cleanup-before-commit-dispatch', async () => {
  let finalAckReceived = false;
  let postAckReads = 0;
  await withClock(async clock => {
    const start = clock.now;
    const file = makeFile(19);
    const peer = createPeer(file, {
      after: record => { if (record.method === methods.chunk) finalAckReceived = true; },
    });
    let failure;
    try {
      const result = await transfer(file, peer, { timeoutMs: 100 });
      assert.equal(result.fileAssigned, true);
      assertNoReplayAfterCommit(peer);
      assert.equal(peer.calls.at(-1).options.timeoutMs, 1);
    } catch (error) {
      failure = error;
    }
    // A implementation may either hand a captured 1 ms budget to commit, or
    // notice expiry before dispatch and clean up. It must not mark an
    // undispatched commit as attempted and leak staging.
    if (failure) {
      assert.equal(failure.code, 'CHROME_VIDEO_TRANSFER_TIMEOUT');
      assertAbortedOnce(peer);
    }
    assert.ok(start > 0);
  }, clock => {
    if (!finalAckReceived) return clock.now;
    postAckReads++;
    return clock.now + (postAckReads === 1 ? 99 : 100);
  });
});

await scenario('commit-transport-failure-never-aborts-or-replays-selection', async () => {
  const file = makeFile(CHROME_VIDEO_CHUNK_BYTES + 19);
  const original = errorWith('UNIT_COMMIT_RESPONSE_LOST');
  const peer = createPeer(file, {
    before: record => { if (record.method === methods.commit) throw original; },
  });
  await rejectWith(transfer(file, peer), original.code, original);
  assertNoReplayAfterCommit(peer);
  assert.equal(peer.calls.at(-1).options.operationId, binding.operationId);
});

await scenario('uncertain-commit-results-demand-reconciliation-without-abort-or-retry', async () => {
  for (const mutation of [
    () => undefined,
    response => ({ ...response, transferId: 'wrong-transfer' }),
    response => ({ ...response, fileAssigned: false }),
    response => ({ ...response, fileAssigned: 'true' }),
    response => ({ ...response, file: undefined }),
    response => ({ ...response, file: { ...response.file, sha256: '0'.repeat(64) } }),
    response => ({ ...response, file: { ...response.file, size: response.file.size + 1 } }),
  ]) {
    const file = makeFile(19);
    const peer = createPeer(file, {
      reply: (record, response) => record.method === methods.commit ? mutation(response) : response,
    });
    const error = await rejectWith(transfer(file, peer), 'CHROME_VIDEO_COMMIT_UNCERTAIN');
    assert.deepEqual(error.details, {
      operationId: binding.operationId, actionDispatched: true, outcomeVerified: false,
    });
    assertNoReplayAfterCommit(peer);
  }
});

await scenario('commit-response-arriving-after-deadline-does-not-trigger-cleanup-or-replay', async () => {
  await withClock(async clock => {
    const file = makeFile(19);
    const peer = createPeer(file, {
      after: record => { if (record.method === methods.commit) clock.now += 1_000; },
    });
    const result = await transfer(file, peer, { timeoutMs: 100 });
    assert.equal(result.fileAssigned, true,
      'A verified commit response must not be discarded and replayed because the budget later elapsed');
    assertNoReplayAfterCommit(peer);
  });
});

console.log(JSON.stringify({
  passed: results.filter(result => result.passed).length,
  total: results.length,
  results,
  environment: 'stubbed-callback-only',
}, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;

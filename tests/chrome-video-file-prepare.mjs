import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_CHROME_VIDEO_FILE_BYTES,
  CHROME_VIDEO_CHUNK_BYTES,
  isMp4Container,
  prepareChromeVideoFile,
} from '../lib/chrome-video-file.mjs';

// No browser, provider, or owner media is accessed. Fixtures stay in a new
// private temporary directory; the oversized fixture is sparse, not a 128 MiB
// allocation. These are MP4 container fixtures, not decodable video/codec tests.
const temporaryDirectory = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-video-prepare-unit-')),
);
await fs.chmod(temporaryDirectory, 0o700);
const results = [];
const secretMarker = 'private-video-fixture-do-not-log';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const NATIVE_MESSAGE_LIMIT = 1024 * 1024;
const ENVELOPE_RESERVE = 16 * 1024;

function box(type, payload = Buffer.alloc(0), { extended = false, toEnd = false } = {}) {
  assert.equal(Buffer.byteLength(type, 'latin1'), 4);
  const header = Buffer.alloc(extended ? 16 : 8);
  header.writeUInt32BE(toEnd ? 0 : extended ? 1 : header.length + payload.length);
  header.write(type, 4, 4, 'latin1');
  if (extended) header.writeBigUInt64BE(BigInt(header.length + payload.length), 8);
  return Buffer.concat([header, payload]);
}
function fileType(major = 'isom', compatible = ['iso2', 'mp42']) {
  return box('ftyp', Buffer.concat([
    Buffer.from(major, 'latin1'),
    Buffer.alloc(4), // minor_version
    ...compatible.map(brand => Buffer.from(brand, 'latin1')),
  ]));
}
const ftyp = fileType();
const moov = box('moov', box('mvhd', Buffer.alloc(12)));
const sampleMedia = Buffer.from([0, 255, 128, 1, 13, 10, 240, 127, 254]);
const smallMp4 = Buffer.concat([ftyp, moov, box('mdat', sampleMedia)]);
const binaryPayload = Buffer.alloc(2 * 1024 * 1024 + 373);
for (let i = 0; i < binaryPayload.length; i++) binaryPayload[i] = i & 255;
binaryPayload.write(secretMarker, 521, 'utf8');
const largeMp4 = Buffer.concat([ftyp, moov, box('mdat', binaryPayload)]);

async function write(name, bytes) {
  const localPath = path.join(temporaryDirectory, name);
  await fs.writeFile(localPath, bytes, { mode: 0o600 });
  return localPath;
}
async function scenario(name, run) {
  try {
    await run();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.message, stack: error.stack });
  }
}
function sanitizedDiagnostic(error) {
  return JSON.stringify({
    code: error.code,
    message: error.message,
    details: error.details,
    cause: error.cause,
  }, (_key, value) => value instanceof Error
    ? { code: value.code, message: value.message, cause: value.cause }
    : value);
}
async function expectRejected(args, expectedCode) {
  await assert.rejects(() => prepareChromeVideoFile(args), error => {
    assert.equal(error.code, expectedCode);
    const diagnostic = sanitizedDiagnostic(error);
    assert.ok(!diagnostic.includes(temporaryDirectory), 'Errors must omit the private source directory');
    if (typeof args?.localPath === 'string' && path.isAbsolute(args.localPath)) {
      assert.ok(!diagnostic.includes(args.localPath), 'Errors must omit the explicit private source path');
    }
    assert.ok(!diagnostic.includes(secretMarker), 'Errors must omit raw media content');
    assert.ok(!diagnostic.includes(Buffer.from(secretMarker).toString('base64')), 'Errors must omit encoded media content');
    assert.ok(!diagnostic.includes(smallMp4.toString('base64')), 'Errors must omit encoded fixtures');
    return true;
  });
}

try {
  await scenario('explicit-bounds', () => {
    assert.equal(MAX_CHROME_VIDEO_FILE_BYTES, 128 * 1024 * 1024);
    assert.equal(CHROME_VIDEO_CHUNK_BYTES, 256 * 1024);
  });

  await scenario('container-supports-fast-start-tail-moov-and-large-size-boxes', () => {
    for (const bytes of [
      smallMp4,
      Buffer.concat([ftyp, box('mdat', sampleMedia), moov]),
      Buffer.concat([ftyp, moov, box('mdat', sampleMedia, { extended: true })]),
      Buffer.concat([ftyp, moov, box('mdat', sampleMedia, { toEnd: true })]),
    ]) assert.equal(isMp4Container(bytes), true);
  });

  await scenario('major-or-compatible-brand-must-explicitly-identify-mp4', () => {
    for (const brand of ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'avc1', 'mp41', 'mp42', 'M4V ', 'dash', 'msdh', 'msix']) {
      assert.equal(isMp4Container(Buffer.concat([
        fileType(brand, []), moov, box('mdat', sampleMedia),
      ])), true, brand);
    }
    assert.equal(isMp4Container(Buffer.concat([
      fileType('zzzz', ['mp42']), moov, box('mdat', sampleMedia),
    ])), true, 'A supported compatible brand is sufficient');
    assert.equal(isMp4Container(Buffer.concat([
      fileType('qt  ', ['qt  ']), moov, box('mdat', sampleMedia),
    ])), false, 'A QuickTime container must not be silently relabeled MP4');
  });

  await scenario('signature-rejects-high-bit-fourcc-lookalikes', () => {
    const badType = Buffer.from(smallMp4);
    badType[4] |= 0x80;
    assert.equal(isMp4Container(badType), false, 'ftyp must match exact bytes, not masked ASCII');

    const badBrand = Buffer.concat([fileType('isom', []), moov, box('mdat', sampleMedia)]);
    badBrand[8] |= 0x80;
    assert.equal(isMp4Container(badBrand), false, 'A high-bit brand must not alias a permitted brand');

    const badMovie = Buffer.from(smallMp4);
    badMovie[ftyp.length + 4] |= 0x80;
    assert.equal(isMp4Container(badMovie), false, 'A high-bit movie box is not moov');

    const badMedia = Buffer.from(smallMp4);
    badMedia[ftyp.length + moov.length + 4] |= 0x80;
    assert.equal(isMp4Container(badMedia), false, 'A high-bit media box is not mdat');
  });

  await scenario('container-rejects-missing-boxes-empty-media-and-truncated-eof', () => {
    for (const [label, bytes] of [
      ['missing-ftyp', Buffer.concat([moov, box('mdat', sampleMedia)])],
      ['ftyp-not-first', Buffer.concat([box('free'), smallMp4])],
      ['missing-moov', Buffer.concat([ftyp, box('mdat', sampleMedia)])],
      ['missing-mdat', Buffer.concat([ftyp, moov])],
      ['empty-mdat', Buffer.concat([ftyp, moov, box('mdat')])],
      ['truncated-media', smallMp4.subarray(0, smallMp4.length - 1)],
    ]) assert.equal(isMp4Container(bytes), false, label);
    for (let count = 1; count <= 7; count++) {
      assert.equal(isMp4Container(Buffer.concat([smallMp4, Buffer.alloc(count)])), false,
        'Trailing partial box header must not be ignored');
    }
    for (const value of [null, undefined, 'ftyp', new Uint8Array(smallMp4)]) {
      assert.equal(isMp4Container(value), false);
    }
  });

  await scenario('container-rejects-invalid-box-lengths-without-reading-past-buffer', () => {
    for (const size of [0, 1, 8, 15, 17, 0xffffffff]) {
      const bytes = Buffer.from(smallMp4);
      bytes.writeUInt32BE(size);
      assert.equal(isMp4Container(bytes), false, 'Invalid ftyp length ' + size);
    }
    const shortBox = Buffer.alloc(8);
    shortBox.writeUInt32BE(7);
    shortBox.write('free', 4);
    const extendedShort = Buffer.alloc(12);
    extendedShort.writeUInt32BE(1);
    extendedShort.write('free', 4);
    const extendedHuge = box('mdat', sampleMedia, { extended: true });
    extendedHuge.writeBigUInt64BE(0xffffffffffffffffn, 8);
    const extendedTooSmall = box('mdat', sampleMedia, { extended: true });
    extendedTooSmall.writeBigUInt64BE(8n, 8);
    for (const bytes of [shortBox, extendedShort, extendedHuge, extendedTooSmall]) {
      assert.equal(isMp4Container(Buffer.concat([ftyp, moov, bytes])), false);
    }
  });

  const localPath = await write('reviewed-video.mp4', largeMp4);
  const valid = { localPath, expectedSha256: digest(largeMp4), mimeType: 'video/mp4' };

  await scenario('prepare-over-one-mib-preserves-every-binary-byte-and-reviewed-metadata', async () => {
    assert.ok(largeMp4.length > NATIVE_MESSAGE_LIMIT);
    const prepared = await prepareChromeVideoFile(valid);
    assert.equal(Buffer.isBuffer(prepared.bytes), true);
    assert.deepEqual(prepared.bytes, largeMp4);
    assert.equal(prepared.name, 'reviewed-video.mp4');
    assert.equal(prepared.mimeType, 'video/mp4');
    assert.equal(prepared.size, largeMp4.length);
    assert.equal(prepared.sha256, valid.expectedSha256);
    assert.equal(digest(prepared.bytes), valid.expectedSha256);
    assert.equal(prepared.lastModified, Math.floor((await fs.stat(localPath)).mtimeMs));
    assert.deepEqual(Object.keys(prepared).sort(),
      ['bytes', 'lastModified', 'mimeType', 'name', 'sha256', 'size']);
  });

  await scenario('binary-chunks-roundtrip-with-native-envelope-headroom', async () => {
    const prepared = await prepareChromeVideoFile(valid);
    // This verifies the preparer's chunk budget and binary representation.
    // End-to-end native framing/ACK routing is covered by the protocol suite.
    const reconstructed = [];
    let total = 0;
    let sequence = 0;
    for (let offset = 0; offset < prepared.size; offset += CHROME_VIDEO_CHUNK_BYTES) {
      const bytes = prepared.bytes.subarray(offset, offset + CHROME_VIDEO_CHUNK_BYTES);
      const json = Buffer.from(JSON.stringify({
        transferId: 'fixture-transfer',
        sequence,
        offset,
        base64: bytes.toString('base64'),
      }), 'utf8');
      assert.ok(json.length + ENVELOPE_RESERVE < NATIVE_MESSAGE_LIMIT,
        'Each chunk and reserved metadata must fit Chrome host-to-extension framing');
      const lengthPrefix = Buffer.alloc(4);
      if (os.endianness() === 'LE') lengthPrefix.writeUInt32LE(json.length);
      else lengthPrefix.writeUInt32BE(json.length);
      const frame = Buffer.concat([lengthPrefix, json]);
      const declaredLength = os.endianness() === 'LE' ? frame.readUInt32LE(0) : frame.readUInt32BE(0);
      assert.equal(declaredLength, frame.length - 4);
      const received = JSON.parse(frame.subarray(4).toString('utf8'));
      assert.equal(received.sequence, sequence);
      assert.equal(received.offset, total);
      const decoded = Buffer.from(received.base64, 'base64');
      assert.deepEqual(decoded, bytes);
      reconstructed.push(decoded);
      total += decoded.length;
      sequence++;
    }
    assert.ok(sequence > 4, 'The fixture must exercise several chunks and a short final chunk');
    assert.equal(total, prepared.size);
    const receivedFile = Buffer.concat(reconstructed);
    assert.deepEqual(receivedFile, largeMp4);
    assert.equal(digest(receivedFile), valid.expectedSha256);
    assert.ok(Buffer.byteLength(JSON.stringify({ base64: prepared.bytes.toString('base64') }))
      > NATIVE_MESSAGE_LIMIT, 'A single-message implementation would exceed the native limit');
  });

  await scenario('invalid-or-implicit-paths-rejected', async () => {
    for (const invalid of [
      undefined, null, 42, '', 'reviewed-video.mp4', '~/reviewed-video.mp4',
      'https://example.test/video.mp4', 'file://' + localPath,
      temporaryDirectory + '/./reviewed-video.mp4',
      temporaryDirectory + '/../' + path.basename(temporaryDirectory) + '/reviewed-video.mp4',
      localPath + '\0.mp4',
    ]) await expectRejected({ ...valid, localPath: invalid }, 'CHROME_VIDEO_PATH_INVALID');
    await expectRejected(undefined, 'CHROME_VIDEO_PATH_INVALID');
  });

  await scenario('mime-must-be-explicit-mp4', async () => {
    for (const mimeType of [undefined, null, 42, '', 'image/png', 'video/webm', 'video/quicktime', 'video/mp4; codecs=avc1']) {
      await expectRejected({ ...valid, mimeType }, 'CHROME_VIDEO_MIME_INVALID');
    }
  });

  await scenario('reviewed-sha256-is-required-and-must-match-the-file', async () => {
    for (const expectedSha256 of [undefined, null, 42, '', 'not-a-digest', '0'.repeat(64)]) {
      await expectRejected({ ...valid, expectedSha256 }, 'CHROME_VIDEO_HASH_MISMATCH');
    }
    const changed = Buffer.from(largeMp4);
    changed[changed.length - 1] ^= 255;
    const changedPath = await write('changed-since-review.mp4', changed);
    await expectRejected({ ...valid, localPath: changedPath }, 'CHROME_VIDEO_HASH_MISMATCH');
  });

  await scenario('signature-and-extension-must-match-declared-video', async () => {
    const disguised = await write('disguised.mp4', Buffer.from('<html>' + secretMarker + '</html>'));
    await expectRejected({ ...valid, localPath: disguised, expectedSha256: digest(await fs.readFile(disguised)) },
      'CHROME_VIDEO_SIGNATURE_MISMATCH');
    const truncated = await write('truncated.mp4', smallMp4.subarray(0, smallMp4.length - 1));
    await expectRejected({ ...valid, localPath: truncated, expectedSha256: digest(await fs.readFile(truncated)) },
      'CHROME_VIDEO_SIGNATURE_MISMATCH');
    const wrongExtension = await write('reviewed-video.mov', smallMp4);
    await expectRejected({ ...valid, localPath: wrongExtension, expectedSha256: digest(smallMp4) },
      'CHROME_VIDEO_SIGNATURE_MISMATCH');
    const upperExtension = await write('uppercase-extension.MP4', smallMp4);
    assert.equal((await prepareChromeVideoFile({
      ...valid, localPath: upperExtension, expectedSha256: digest(smallMp4),
    })).size, smallMp4.length);
  });

  await scenario('missing-file-and-nonregular-file-have-sanitized-errors', async () => {
    await expectRejected({ ...valid, localPath: path.join(temporaryDirectory, 'missing.mp4') },
      'CHROME_VIDEO_READ_FAILED');
    const directory = path.join(temporaryDirectory, 'directory.mp4');
    await fs.mkdir(directory, { mode: 0o700 });
    await expectRejected({ ...valid, localPath: directory }, 'CHROME_VIDEO_NOT_REGULAR');
  });

  await scenario('direct-and-parent-symlinks-are-not-followed', async () => {
    const direct = path.join(temporaryDirectory, 'linked.mp4');
    await fs.symlink(localPath, direct);
    await expectRejected({ ...valid, localPath: direct }, 'CHROME_VIDEO_SYMLINK');
    const alias = path.join(temporaryDirectory, 'directory-alias');
    await fs.symlink(temporaryDirectory, alias);
    await expectRejected({ ...valid, localPath: path.join(alias, path.basename(localPath)) },
      'CHROME_VIDEO_SYMLINK');
  });

  await scenario('empty-and-one-byte-over-limit-files-rejected-before-payload-allocation', async () => {
    const empty = await write('empty.mp4', Buffer.alloc(0));
    await expectRejected({ ...valid, localPath: empty, expectedSha256: digest(Buffer.alloc(0)) },
      'CHROME_VIDEO_TOO_LARGE');
    const oversized = await write('oversized.mp4', Buffer.alloc(0));
    await fs.truncate(oversized, MAX_CHROME_VIDEO_FILE_BYTES + 1);
    await expectRejected({ ...valid, localPath: oversized }, 'CHROME_VIDEO_TOO_LARGE');
  });

  await scenario('file-growth-during-read-is-rejected-and-handle-is-closed', async () => {
    const changingPath = await write('grows-during-read.mp4', largeMp4);
    const originalOpen = fs.open;
    let injected = false;
    let closed = false;
    // Deterministically mutate only this fixture immediately after its first
    // real read, instead of relying on timing races against the filesystem.
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] !== changingPath) return handle;
      const originalRead = handle.read.bind(handle);
      const originalClose = handle.close.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await originalRead(...readArgs);
        if (result.bytesRead && !injected) {
          injected = true;
          await fs.appendFile(changingPath, Buffer.from([0xa5]));
        }
        return result;
      };
      handle.close = async () => {
        closed = true;
        return originalClose();
      };
      return handle;
    };
    try {
      await expectRejected({ ...valid, localPath: changingPath }, 'CHROME_VIDEO_CHANGED');
      assert.equal(injected, true, 'The mutation must actually occur during the read');
      assert.equal(closed, true, 'Rejected reads must still release the file descriptor');
    } finally {
      fs.open = originalOpen;
    }
  });
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
  console.log(JSON.stringify({
    passed: results.filter(result => result.passed).length,
    total: results.length,
    results,
    temporaryDirectoryRemoved: true,
  }, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;

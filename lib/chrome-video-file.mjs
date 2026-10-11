import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const MAX_CHROME_VIDEO_FILE_BYTES = 128 * 1024 * 1024;
export const CHROME_VIDEO_CHUNK_BYTES = 256 * 1024;
const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "avc1", "mp41", "mp42", "M4V ", "dash", "msdh", "msix"]);

function videoError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Validate an MP4 container, not its codec or playback. The website's media
// decoder and post-upload readback remain separate acceptance checks.
export function isMp4Container(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.toString("latin1", 4, 8) !== "ftyp") return false;
  const ftypSize = bytes.readUInt32BE(0);
  if (ftypSize < 16 || ftypSize > bytes.length || ftypSize % 4 !== 0) return false;
  const brands = [bytes.toString("latin1", 8, 12)];
  for (let offset = 16; offset + 4 <= ftypSize; offset += 4) brands.push(bytes.toString("latin1", offset, offset + 4));
  if (!brands.some(brand => MP4_BRANDS.has(brand))) return false;
  let offset = 0;
  let boxes = 0;
  let hasMovie = false;
  let hasMedia = false;
  while (offset < bytes.length) {
    if (++boxes > 4096 || offset + 8 > bytes.length) return false;
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) return false;
      const extended = bytes.readBigUInt64BE(offset + 8);
      if (extended > BigInt(bytes.length - offset)) return false;
      size = Number(extended);
      header = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (size < header || size > bytes.length - offset) return false;
    if (type === "moov") hasMovie = true;
    if (type === "mdat" && size > header) hasMedia = true;
    offset += size;
  }
  return offset === bytes.length && hasMovie && hasMedia;
}

// Read only the caller's explicit reviewed path. Never discover files, follow
// symlinks, fetch URLs, or include private paths/bytes in errors or audit data.
export async function prepareChromeVideoFile({ localPath, expectedSha256, mimeType } = {}) {
  if (typeof localPath !== "string" || !path.isAbsolute(localPath) || localPath.includes("\0")
      || localPath.length > 4096 || path.resolve(localPath) !== localPath) {
    throw videoError("CHROME_VIDEO_PATH_INVALID", "An absolute normalized video path is required.");
  }
  if (mimeType !== "video/mp4") throw videoError("CHROME_VIDEO_MIME_INVALID", "Only reviewed MP4 videos are supported.");
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw videoError("CHROME_VIDEO_HASH_MISMATCH", "The expected SHA-256 video digest is required.");
  }
  const name = path.basename(localPath);
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/.test(name)) {
    throw videoError("CHROME_VIDEO_PATH_INVALID", "Use an ordinary video filename.");
  }
  let handle;
  try {
    const initial = await fsp.lstat(localPath);
    if (initial.isSymbolicLink() || await fsp.realpath(localPath) !== localPath) {
      throw videoError("CHROME_VIDEO_SYMLINK", "The explicit video path must not contain a symlink.");
    }
    if (!initial.isFile()) throw videoError("CHROME_VIDEO_NOT_REGULAR", "The explicit video must be a regular file.");
    if (path.extname(name).toLowerCase() !== ".mp4") {
      throw videoError("CHROME_VIDEO_SIGNATURE_MISMATCH", "The video filename extension does not match its MIME type.");
    }
    if (initial.size < 1 || initial.size > MAX_CHROME_VIDEO_FILE_BYTES) {
      throw videoError("CHROME_VIDEO_TOO_LARGE", "The video must be between 1 byte and 128 MiB.");
    }
    handle = await fsp.open(localPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile()) throw videoError("CHROME_VIDEO_NOT_REGULAR", "The explicit video must be a regular file.");
    if (before.dev !== initial.dev || before.ino !== initial.ino || before.size !== initial.size
        || before.mtimeMs !== initial.mtimeMs || before.ctimeMs !== initial.ctimeMs) {
      throw videoError("CHROME_VIDEO_CHANGED", "The video changed before it could be read.");
    }
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, Math.min(CHROME_VIDEO_CHUNK_BYTES, buffer.length - length), length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    const current = await fsp.lstat(localPath);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs || current.isSymbolicLink() || !current.isFile()
        || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
        || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs
        || await fsp.realpath(localPath) !== localPath) {
      throw videoError("CHROME_VIDEO_CHANGED", "The video changed while it was being read.");
    }
    const bytes = buffer.subarray(0, length);
    if (!isMp4Container(bytes)) {
      throw videoError("CHROME_VIDEO_SIGNATURE_MISMATCH", "The file is not a supported MP4 container.");
    }
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expectedSha256) throw videoError("CHROME_VIDEO_HASH_MISMATCH", "The video no longer matches the reviewed SHA-256 digest.");
    return { name, mimeType, size: bytes.length, sha256, bytes, lastModified: Math.floor(before.mtimeMs) };
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("CHROME_VIDEO_")) throw error;
    throw videoError(error?.code === "ELOOP" ? "CHROME_VIDEO_SYMLINK" : "CHROME_VIDEO_READ_FAILED", "The explicit video could not be read safely.");
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

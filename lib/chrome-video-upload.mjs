import crypto from "node:crypto";
import { CHROME_VIDEO_CHUNK_BYTES } from "./chrome-video-file.mjs";

// The callback uses the normal grant/profile-checked Chrome route. No private
// transport, picker bypass, URL fetch or page credentials are exposed here.
export async function transferChromeVideoFile({
  file, tabId, selector, expectedDocumentId, operationId, call, timeoutMs = 45_000,
}) {
  const deadline = Date.now() + timeoutMs;
  const transferId = crypto.randomUUID();
  const internalId = "video:" + crypto.createHash("sha256").update(operationId).digest("hex").slice(0, 40);
  const common = { tabId, selector, expectedDocumentId, transferId };
  const { name, mimeType, size, sha256, lastModified } = file;
  const metadata = { name, mimeType, size, sha256, lastModified };
  let began = false;
  let commitAttempted = false;
  let chunks = 0;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms < 1) {
      const error = new Error("Video transfer deadline elapsed before the next phase. Reconcile the operation before retrying.");
      error.code = "CHROME_VIDEO_TRANSFER_TIMEOUT";
      throw error;
    }
    return ms;
  };
  const phase = (method, args, id) => call(method, args, { operationId: id, timeoutMs: remaining() });
  const assertAck = (ack, bytes, index = null) => {
    if (ack?.transferId !== transferId || ack?.receivedBytes !== bytes
        || (index !== null && (ack.index !== index || ack.nextIndex !== index + 1))) {
      const error = new Error("The video transfer acknowledgement did not match the exact chunk.");
      error.code = "CHROME_VIDEO_ACK_MISMATCH";
      throw error;
    }
  };
  try {
    // Begin is also considered live if its response is uncertain; abort only
    // clears staged bytes and never emits input/change or submits anything.
    began = true;
    const start = await phase("tabs.videoFileBegin", { ...common, file: metadata }, internalId + ":begin");
    assertAck(start, 0);
    for (let offset = 0; offset < size; offset += CHROME_VIDEO_CHUNK_BYTES) {
      const end = Math.min(size, offset + CHROME_VIDEO_CHUNK_BYTES);
      const ack = await phase("tabs.videoFileChunk", {
        ...common, index: chunks, offset,
        base64: file.bytes.subarray(offset, end).toString("base64"),
      }, internalId + ":chunk:" + chunks);
      assertAck(ack, end, chunks);
      chunks += 1;
    }
    // The caller's stable public ID identifies the only phase with page side
    // effects. Never abort or automatically replay after attempting this phase.
    const commitTimeoutMs = remaining();
    commitAttempted = true;
    const result = await call("tabs.videoFileCommit", common, { operationId, timeoutMs: commitTimeoutMs });
    if (result?.transferId !== transferId || result?.fileAssigned !== true
        || result?.file?.sha256 !== sha256 || result?.file?.size !== size) {
      const error = new Error("Video selection returned an uncertain result. Read the page and reconcile the operation before any further action.");
      error.code = "CHROME_VIDEO_COMMIT_UNCERTAIN";
      error.details = { operationId, actionDispatched: true, outcomeVerified: false };
      throw error;
    }
    // Return a small allowlist even if a future transport adds payload fields.
    const output = {
      transferId, state: "committed", fileAssigned: true,
      file: { name, mimeType, size, sha256 },
      inputEventDispatched: result.inputEventDispatched === true,
      changeEventDispatched: result.changeEventDispatched === true,
      fileRetained: result.fileRetained === true,
      fileCount: Number.isSafeInteger(result.fileCount) ? result.fileCount : null,
      trusted: false, applicationAccepted: null,
      actionDispatched: true, operationId,
      transferredBytes: size, chunkCount: chunks,
    };
    for (const key of [
      "tabId", "documentId", "frameId", "targetTabId", "targetFrameId", "targetDocumentId",
      "outcomeVerified", "navigationObserved", "popupObserved", "popupObservedCount",
      "submissionRequested", "submissionObserved", "submissionBlocked",
    ]) {
      const value = result[key];
      if (["string", "number", "boolean"].includes(typeof value)) output[key] = value;
    }
    if (result._background) output._background = {
      focusPolicy: "background-only", provider: typeof result._background.provider === "string" ? result._background.provider : null,
    };
    return output;
  } catch (error) {
    if (began && !commitAttempted) {
      try {
        await call("tabs.videoFileAbort", common, {
          operationId: internalId + ":abort", timeoutMs: 1_000,
        });
      } catch { /* Expiring isolated staging is also cleared by its TTL. */ }
    }
    throw error;
  }
}

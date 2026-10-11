# Reviewed MP4 video selection

`chrome_set_video_input` selects one reviewed local MP4 in an observed Chrome file input. It retains existing URL grants, profile checks and background-only operation. Selecting a file can immediately start the website's own upload; use it only for an authorized destination and reviewed bytes.

## Prepare the exact file and target

1. Finish reviewing the clip, including audio, ending and intended audience. Use a regular `.mp4` file of at most **128 MiB (134,217,728 bytes)**. The bridge verifies MP4 container structure; codec support, playback and website limits remain separate checks.
2. Record its absolute normalized path and SHA-256. Neither the file nor any path component may be a symlink. The basename must start with an ASCII letter or digit, contain only ASCII letters, digits, spaces, periods, underscores or hyphens, and be at most 200 characters.
3. Compute the digest after the last edit, for example `shasum -a 256 /absolute/path/reviewed-clip.mp4`. Preserve the reviewed bytes. The bridge checks file identity and metadata around the read, then requires the supplied digest to match.
4. Obtain a fresh `chrome_snapshot` of the authorized destination. Record its exact `documentId` and an observed selector matching one enabled file input. The input must accept MP4 and have no existing selection. Keep one stable operation ID for this exact selection.

## Public tool schema

All fields are required; additional properties are rejected.

| Field | Type and constraint |
| --- | --- |
| `tab_id` | Nonnegative integer identifying the observed tab. |
| `selector` | Exact observed CSS selector, 1–10,000 characters; must match one file input. |
| `expected_document_id` | Fresh snapshot document ID, 1–128 letters, digits, underscores or hyphens. |
| `local_path` | Absolute normalized local path, 1–4,096 characters. No URLs, discovery, directories or symlinks. |
| `mime_type` | Exactly `video/mp4`. |
| `expected_sha256` | Exactly 64 lowercase hexadecimal characters for the reviewed file. |
| `operation_id` | 8–128 characters; starts with a letter or digit, then letters, digits, periods, underscores, colons or hyphens. |

## Call through public MCP stdio

During a rolling upgrade, the shared HTTP child may still expose its older tool catalogue. The public client starts a fresh `bridge.mjs` beside the script, using the existing environment and unlock/grant/profile configuration:

```sh
node /absolute/path/mac-developer-bridge/scripts/mcp-call-stdio.mjs <<'JSON'
{"method":"tools/list","params":{}}
JSON
```

For selection, pass one `tools/call` request to that same command. Replace every placeholder with reviewed, observed values; the following is a template:

```json
{
  "method": "tools/call",
  "params": {
    "name": "chrome_set_video_input",
    "arguments": {
      "tab_id": 0,
      "selector": "<observed file-input selector>",
      "expected_document_id": "<fresh documentId>",
      "local_path": "/absolute/path/reviewed-clip.mp4",
      "mime_type": "video/mp4",
      "expected_sha256": "<reviewed lowercase SHA-256>",
      "operation_id": "reviewed-video-001"
    }
  }
}
```

The client performs MCP initialization and sends `notifications/initialized`, waits for the single response, then closes its child stdin and awaits exit. Do not send raw bridge requests followed by immediate EOF: EOF tears down that process and can abort its work. The client has a 55-second deadline; a timeout requires reconciliation. It does not restart the shared HTTP bridge or require its transport token. Do not change grants, unlock settings or the data directory to use it.

## Transfer and result boundaries

The bridge sends sequential **256 KiB (262,144-byte)** chunks through the normal checked Chrome route, with a 45-second overall transfer deadline. Each acknowledgement must match the transfer, chunk index and received byte count.

Staging lives in the extension's **ISOLATED** execution world, bound to the original tab, document, URL, selector and input element. One transfer may be staged per document. Staged bytes expire after 15 minutes and are released on completion, abort or handled failure. Extension session storage holds expiry metadata for the reload guard. Staging does not assign the file or emit input events.

Commit reassembles the bytes, checks the SHA-256 again and revalidates the original target. It assigns one file and sends one synthetic `input`/`change` pair. It opens no picker and performs no focus, click or explicit submission. A replacement document/input or existing selection is refused.

A successful receipt reports the file digest/size, transfer counts, assignment, event dispatch and retained selection. Events are untrusted (`trusted: false`); `applicationAccepted: null` is intentional. Read the resulting page to verify upload progress, processing, preview and errors. Any later publication needs its own authorized action and application readback.

## Uncertain outcomes

Keep the original `operation_id`. Query `chrome_operation_status` with that ID and inspect a fresh page snapshot before further action. The public ID belongs to the commit phase; a missing public record does not prove that no staging occurred.

Before attempting commit, the bridge makes a best-effort staging abort on failure. After a commit attempt it neither aborts nor automatically replays: selection may already have started an upload. A lost response, timeout, disconnect or `unknown` status is not permission to retry with a new ID. Reconcile the operation and actual page state first.

## Rolling installation and extension reload

1. Preserve the existing installation's local changes, especially service-worker patches. Apply the upload overlay to a combined candidate; record original/candidate hashes and validate that exact combined source. Do not replace a dirty service worker wholesale.
2. Install the reviewed bridge modules, public stdio client and extension changes into the existing installation. Verify installed hashes. Preserve the native-host registration, profile binding, grants, unlock and HTTP configuration.
3. Use the installed stdio client for new tools while the shared HTTP child continues running. Its old catalogue is expected until its normal restart; killing that child interrupts its pending calls and owned processes.
4. Arrange a quiet window with other browser workers and let their active calls finish. Do not close or release other workers' tabs. Read `bridge_status` and inspect/reconcile known pending or uncertain operations.
5. Call `chrome_reload_extension` once with `expected_build_id` equal to the **currently running** build and a stable `operation_id` using the same format as above. The tool installs no code. The updated extension refuses reload while other native operations or staged uploads are active and reserves the reload window against new work.
6. After reconnect, verify `bridge_status`: extension ready, build `browser-video-file-upload-20261011.3`, expected loaded identities, a new connection generation and healthy mutation journal. Check workspace continuity and a disposable loopback upload before proceeding with an authorized destination.

**First upgrade caveat:** older extensions lack the active-operation/staged-upload reload guard. An empty mutation journal or idle workspace does not establish quiescence; read-only operations may be active. The first old-to-new reload therefore depends on the coordinated quiet window and cannot promise zero disruption. If its response is lost, inspect status and the reload operation before another attempt. Later reloads gain the new guard once this build is actually running.

Implementation: [file preparation](../lib/chrome-video-file.mjs), [transfer orchestration](../lib/chrome-video-upload.mjs), [public client](../scripts/mcp-call-stdio.mjs), [extension](../chrome-extension/service-worker.js).

## Current web-component composers

`chrome_snapshot` also inspects bounded open shadow roots. It returns exact observed selectors using ` >>> ` for each open-root boundary. Copy those selectors unchanged into `chrome_click`, `chrome_fill`, or `chrome_set_video_input`. Closed roots and child frames are not traversed. Other selector-based operations retain their existing support.

Snapshots expose passive video metadata (source URL without query tokens, duration, dimensions, ready state and media error) and bounded selected-file metadata. Use these to verify that a composer actually has a preview and that a published post contains native video. Reading this metadata never starts playback or uploads a file.

A site can consume a selected file and reset its input; `fileRetained: false` alone does not prove success or failure. Likewise, a controlled text editor may consume an input event while cancelling its default action. Inspect the resulting field or player before repeating an uncertain interaction.

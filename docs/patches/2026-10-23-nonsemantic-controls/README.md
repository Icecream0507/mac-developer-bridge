# Custom browser controls (2026-10-23)

## What this adds

The existing `chrome_snapshot` tool now has two optional fields:

- `include_nonsemantic: true` discovers bounded, rendered HTML labels/cards, href-less anchors and custom HTML elements with a pointer cursor or an inline click attribute even when they lack a native control type, ARIA role or tab index.
- `text_query: "When customer visits a page"` finds exact rendered text, ignoring case and collapsing whitespace, and returns the observed selectors. It also finds labels without a pointer cursor. It is not a regex or script evaluator.

Use the returned selector with the existing `chrome_click`, then read the page again. Inferred candidates are marked `discovery: "nonsemantic"`, include `interactionHints`, and do not assert that a handler exists or a business action succeeded. Multiple matches remain separate; choose the intended target from observed context instead of automatically clicking the first one.

```json
{
  "tab_id": 123,
  "max_text_chars": 2000,
  "max_elements": 50,
  "text_query": "When customer visits a page"
}
```

Only the normal document and existing open shadow roots are searched. Nested native/ARIA controls retain precedence. Repeated wrappers are reduced to their innermost rendered label; click bubbling can then reach delegated application handlers. There is no framework-state inspection or handler-source access.

Discovery scans at most 5,000 of the existing bounded DOM walk's elements and adds at most `min(200, max_elements)` candidates. The overall returned element list still respects `max_elements`. `nonsemanticDiscovery` reports the mode, bounds and incomplete scans, and `elementsTruncated` is true for an incomplete enhanced search. No match in a truncated search is not proof of absence.

Hidden, transparent, inert, ARIA-hidden and ARIA-disabled ancestor subtrees are excluded from enhanced targets. Ancestry checks stop after 64 levels and reject unresolved visibility. Only `innerText` is used for new labels, never a hidden `textContent` fallback. Passwords remain redacted. Some non-text/icon-only controls, canvas content, closed shadow roots, frames and trusted-user-gesture flows remain outside this feature.

## Compatibility and deployment

Omitted options preserve the existing payload and behavior. Layout diagnostics remain opt-in. The extension is version 0.2.23 with build ID `browser-nonsemantic-controls-20261023.2`. Permissions, profile binding, grants, document identity, action deadlines and mutation reconciliation are unchanged.

The bridge source publishes both options in the public MCP schema. A long-lived connector can retain an older schema or bridge child until its normal reconnect. The existing public stdio client loads the installed source immediately without restarting the shared HTTP front end:

```sh
printf '%s' '{"method":"tools/call","params":{"name":"chrome_snapshot","arguments":{"tab_id":123,"text_query":"When customer visits a page","max_text_chars":2000,"max_elements":50}}}' \
  | node scripts/mcp-call-stdio.mjs
```

This is the public MCP interface, not direct access to browser credentials, internal application APIs or the extension's private socket. After installation, use `chrome_reload_extension` with the exact current build and an operation ID, then verify `bridge_status` reports the new build. Do not restart Chrome or alter grants to enable the feature.

## Tests

```sh
npm run check
npm test
node tests/chrome-snapshot-layout-diagnostics.mjs
node tests/chrome-snapshot-media-diagnostics.mjs
node tests/chrome-open-shadow.mjs
MDB_BROWSER_TEST_PLAYWRIGHT=/path/to/playwright/index.mjs \
  MDB_BROWSER_TEST_BASELINE=/path/to/pre-patch/service-worker.js \
  node tests/chrome-nonsemantic-controls.mjs
```

The new real-browser test creates and removes a disposable headless Chromium profile, blocks external network access, and uses only owned in-memory HTML. It checks opt-in backward compatibility, delegated card clicks, exact text lookup, ambiguity, native-control precedence, hidden/disabled ancestors, open versus closed shadow roots, frame exclusion, password and handler privacy, passive inspection, count/scan bounds and hidden descendant text. Running this test does not attach to the owner's Chrome profile.

## Isolated release archive

This branch stores only the reviewed overlay, not unrelated pre-existing working-tree changes. The installed bridge tree already contains several earlier repairs that are not all in the checkout HEAD. Therefore this patch must be applied to the exact baseline recorded in `manifest.json`, not blindly to a clean main branch.

`verify_overlay.py /path/to/source` accepts either the exact baseline or the exact candidate. It applies (and, for a candidate, reverses) the patch only in a temporary copy, checks every before/after SHA-256 and JavaScript syntax, and confirms the target was not changed. Use this before any installation. Keep a backup, apply `nonsemantic-controls-only.patch` with normal `git apply`, and copy the new test into `tests/chrome-nonsemantic-controls.mjs`. Existing release-identity assertions are updated to the installed version; their behavioral checks are unchanged.

The authenticated acceptance receipt deliberately omits account IDs, profile emails, URLs and customer data. The acceptance exercise opened settings menus only. It did not publish a workflow or send a customer message.

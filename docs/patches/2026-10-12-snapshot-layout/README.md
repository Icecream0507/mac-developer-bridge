# Optional snapshot layout diagnostic — review proposal

Status: source delta installed after a quiet boundary; supported guarded reload
and the live opt-in diagnostic were verified by the parent agent. See
source_apply_receipt.json and runtime_receipt.json. The manifest records the
original proposal capture, rather than asserting the current runtime state.

## Purpose

The Salesforge builder snapshot reports thirteen controls and no graph text.
Ordinary div/SVG/canvas graph nodes may not enter the interactive-control list.
This optional diagnostic distinguishes no observed graph nodes from zero-area,
locally hidden, offscreen, or present containers without reading saved application
state, hidden text, HTML, frame documents, canvas pixels, network responses or URLs.

## Exact change

The patch changes bridge.mjs, chrome-extension/service-worker.js and the
extension manifest, updates only current-release expectations in the background
and media snapshot tests, and adds tests/chrome-snapshot-layout-diagnostics.mjs.
Release identity: 0.2.22 / browser-layout-snapshot-20261012.1. Old-version
transport fixtures are unchanged.

chrome_snapshot accepts include_layout: true. Omitted or false preserves its
existing wire arguments and return fields. Only strict true opts in at the worker.
The same getApprovedTab gate, ISOLATED execution, deadline, and document identity
route apply. The existing 20,000-element / 512-root / 16-depth open-root walk is
reused. No new walker, frame traversal, closed-root access, events, focus change,
style write, storage access, network request, control action, or permission change
is added. Existing snapshot fields continue their existing behavior.

The optional layoutDiagnostics field contains:
- Passive document visibility/focus and viewport dimensions.
- Counts for ReactFlow roots, renderers, panes, viewports, node containers, nodes.
- Up to four samples for each container category; up to fifty node samples.
- Counts and up to eight samples each for svg, canvas and iframe elements.
- Up to eight ancestor rectangles/styles for each sampled ReactFlow root.
- Integer element references within the existing observed-element list; no IDs,
  labels, selectors, arbitrary attributes or class strings.
- Rectangles, bounded numeric matrix transforms, allowlisted computed-style
  enums, local hidden flag, positive-area flag, and viewport-intersection flag.
- Explicit sample truncation and traversal lower-bound flags.

Each sample group is also limited by max_elements. All numeric output is finite
and within plus/minus ten million; unsupported values become null. Styles are
allowlisted enums, numeric opacity, and a bounded numeric matrix. Measurement
failures expose no exception messages.

## Interpretation

The metadata records mounted DOM at snapshot time, not saved server state.
Positive size and local-style flags do not prove visibility through all ancestor
clipping, occlusion, or stacking. Root ancestors and container categories help
identify common zero-size/hidden-container causes. Canvas/SVG/iframe presence does
not reveal their content. The diagnostic itself cannot verify the stored email
bodies. Use existing permitted controls to inspect an editor if nodes become
available; otherwise retain the copy-verification limitation.

## Verification completed

- Candidate bridge and worker pass node --check.
- All twelve source-only layout synthetic scenarios pass.
- Existing default media snapshot and full background suites pass.
- Open-shadow 16/16, CSV 59/59 and image 26/26 scenarios pass.
- Default return payload compared to the captured baseline.
- Visible/noninteractive, zero-size, hidden, transparent, content-hidden,
  offscreen and partially intersecting fixtures.
- Sample/read caps, ancestor caps and the existing 20,000-element traversal cap.
- Open-root discovery while closed-root and frame content remain unobserved.
- No additional text/HTML/label/framework state/URL/canvas-content reads or events.
- Numeric/style/error redaction and disconnected-element behavior.
- Strict boolean route; unchanged approved-tab, ISOLATED, deadline and document
  identity behavior; approval denial stops before execution.
- Unified patch forwards from exact baseline to exact candidate hashes and
  reverses to exact baseline hashes with whitespace errors rejected.
- Active runtime hashes remained unchanged during proposal/testing. The parent
  then applied the exact guarded patch and verified the loaded release identity
  at a quiet boundary, without restarting the shared HTTP process.

Evidence: baseline_manifest.json, manifest.json, and test-results.json.

## Apply at a safe boundary only

The caller must finish active billing/validation/enrollment operations before
any deployment or reload. The proposal includes the reviewed release identity
0.2.22 / browser-layout-snapshot-20261012.1. Use the supported reload busy-operation
guard and verify that exact loaded version/build identity. Never restart the
shared HTTP process for this change.

Before applying, require every manifest.json changes[].before_sha256 hash to
match the current target (null means the new file must not exist), and require
every unchanged_active_prerequisites hash to match. Reject a mismatch and recapture
/review; do not force-apply or three-way-merge into a different runtime baseline.

Then use git apply --check --whitespace=error against snapshot-layout-only.patch,
review its exact six-file diff, and apply that same patch. Confirm candidate
hashes after application and run:

~~~sh
node --check bridge.mjs
node --check chrome-extension/service-worker.js
node tests/chrome-snapshot-layout-diagnostics.mjs /path/to/exact-captured-baseline
~~~

The verifier never deploys or reloads runtime processes. The parent separately
used the supported guarded reload and public stdio snapshot; receipts record that
completed boundary.

Do not commit the baseline/candidate copies of the existing dirty working tree.
For durable review, persist only the narrow patch, new test, manifests/evidence,
and this README, or port the reviewed change with its necessary dependency closure
through the existing isolated-worktree workflow. No contact data is included.

## Hash-gated verifier

From this artifact directory:

~~~sh
python3 verify_apply.py installed /path/to/checkout
python3 verify_apply.py check /path/to/exact-baseline-checkout
~~~

The first command verifies candidate source hashes without implying runtime
readiness. The second performs baseline/prerequisite verification and a private
forward/reverse patch roundtrip, without modifying the target. Explicit apply mode
is available only for the exact captured baseline:

~~~sh
python3 verify_apply.py apply /path/to/exact-baseline-checkout
~~~

The new test must be absent on that baseline. A changed source/prerequisite hash,
symlink, non-regular target or unlisted patch path is refused. This is a patch
artifact against a reviewed working-source baseline, not a claim that the patch
applies to clean repository HEAD. Existing upload/open-shadow changes are required
prerequisites and are not copied into this artifact.

## Live result and remaining limit

The successful opt-in call preserved the normal snapshot controls. It reported
one positive-area graph root/viewport and five positive-area graph nodes whose
computed visibility was hidden. The nodes are mounted, so the earlier missing
text does not establish an empty saved graph. Hidden email text and application
state were not read; stored copy remains unverified. Only counts, geometry/style
summary and readiness metadata are retained in the receipt.

## Tracking and scope

This commit contains only this artifact directory. It does not commit the dirty
active runtime, unrelated workspace/ChatGPT changes or any contact/customer data.
Beads task creation was blocked by an existing ancestor database missing its
issue_prefix configuration; no shared database initialization or repair was
performed. The earlier CSV patch artifact remains independently recorded at
commit a964ba3390175e74b1e2763a808038d731acc7d8.

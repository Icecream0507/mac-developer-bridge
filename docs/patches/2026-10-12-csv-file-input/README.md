# Reviewed CSV file-input patch — 2026-10-12

This directory preserves the exact CSV support change applied to an existing reviewed Mac Developer Bridge runtime. It is a **patch artifact**, not a claim that the Git base commit contains the required runtime dependencies.

The artifact branch starts at commit 94704cf6858f7ac5e315181a1b2d4a54e9df64b0. The captured runtime already contained reviewed background-browser, image/video, document-identity, and durable-operation work that was not committed in that base. Only the CSV delta and associated tests are stored here. No owner working-tree snapshot, contact records, credentials, or deployment configuration is included.

## Change and behavior

The chrome_set_file_input tool additionally accepts text/csv files with a .csv extension, limited to 1 MiB. Both the bridge and browser require valid UTF-8 comma-separated records with consistent column counts, valid quoting, and no binary control bytes. A UTF-8 BOM, CRLF line endings, escaped quotes, commas, and newlines inside quoted fields are supported without rewriting reviewed bytes.

CSV selection requires an empty native file input. That guard is checked again after asynchronous digest verification and before assignment. MIME-family matching prevents image/* inputs from accepting CSV. Existing image semantics remain supported.

The original canonical path, symlink, regular-file identity, size, extension, SHA-256, URL grant, profile binding, exact document, target identity, deadline, audit-redaction, and durable operation controls remain in force. The action assigns one FileList and dispatches one synthetic input/change pair. It does not open a picker, focus Chrome, click, submit, replay an uncertain operation, alter permissions, or bypass application API roles. Selection can start a website's own upload; assignment alone does not prove application acceptance or saved persistence.

## Contents

| File | Purpose |
|---|---|
| .gitattributes | Treat unified-diff context markers as patch payload, while source application still enforces whitespace checks |
| csv-only.patch | Exact five-file runtime delta, including the new CSV preparer |
| background-test.patch | Current release identity and equivalent selector-contract assertions |
| files/tests/chrome-csv-file-input.mjs | New synthetic CSV preparation and browser-action tests |
| manifest.json | Captured before/installed SHA-256 values, unchanged prerequisite hashes, and artifact hashes |
| verify_apply.py | Fail-closed verification and optional exact-baseline application |
| validation.json | Test results and provenance of installed-browser verification |
| roundtrip-result.json | Exact-baseline, installed, disposable-apply, and mismatch-refusal proof |
| tracking.json | Task state, follow-up integration work, and Beads availability limitation |

The background-test patch preserves synthetic old-version fixtures. It updates the current manifest/worker version assertions, checks the guarded selector lookup with its typed invalid-selector and exact-one-target failures, and checks the equivalent uniqueness predicate used by open shadow selectors.

## Review and verification

Use Python 3 and Git. The verifier checks every changed file and four unchanged safety prerequisites against manifest.json, rejects symlinks, validates artifact hashes, and proves both patch directions in a private temporary directory. It copies only the seven changed files for that proof.

To verify a captured pre-change runtime without modifying it:

~~~bash
python3 docs/patches/2026-10-12-csv-file-input/verify_apply.py \
  --mode check --target /absolute/path/to/captured-runtime
~~~

To verify an already installed runtime without modifying it:

~~~bash
python3 docs/patches/2026-10-12-csv-file-input/verify_apply.py \
  --mode installed --target /absolute/path/to/installed-runtime
~~~

Every expected digest must match. Missing prerequisites, different source, or an existing file where the baseline requires absence cause refusal. The Git base checkout alone will fail verification because it lacks the captured runtime prerequisites.

## Applying the reviewed delta

After reviewing the patch and confirming that the target is the exact captured baseline:

~~~bash
python3 docs/patches/2026-10-12-csv-file-input/verify_apply.py \
  --mode apply --target /absolute/path/to/captured-runtime
~~~

This is the verifier's only target-mutating mode. It repeats baseline checks immediately before a single git apply of the runtime delta, background-test delta, and new test addition, and checks installed hashes afterward. It does not stage or commit target files, reload the bridge or extension, launch a browser, or execute application actions.

Do not bypass a digest mismatch or apply this artifact directly to unrelated source. First integrate and review the prior runtime work, then port this delta and rerun the relevant checks.

From the resulting runtime directory:

~~~bash
npm run check
node tests/chrome-csv-file-input.mjs
node tests/chrome-image-file-input.mjs
node tests/chrome-background.mjs
node tests/chrome-transport-reliability.mjs
~~~

## Validation recorded for this artifact

- CSV preparation/action suite: **59/59 passed**.
- Existing image suite: **26/26 passed**.
- Background Chrome suite: **passed** after current contract assertions were aligned.
- Syntax/build check and transport reliability: **passed**, with **16 transport groups** reported by the implementing agent.
- Installed Chrome loopback fixture: the implementing agent verified refusal for an image-only target and successful exact-hash CSV selection through the public background route.

The CSV and image suites use synthetic inputs and private temporary directories. The CSV action tests cover source path/hash/type/size constraints, UTF-8 and CSV structure, MIME-family acceptance, existing selection protection including the digest-await race, stale or replaced targets, document/URL grant checks, one event pair, no implicit focus/picker/click/submit/network action, audit privacy, and operation fingerprint binding.

Extension release identity: 0.2.21, build browser-csv-file-upload-20261012.1. File hashes describe the captured installed source, not an inference from a version string.

## Follow-up integration

The artifact is suitable for review and exact-baseline reproduction. A future integration change must bring the prior reviewed browser reliability/upload dependencies into coherent source history before treating this as an ordinary source feature commit. That integration is separate from preserving this scoped patch and must not silently absorb unrelated working-tree changes.

Beads onboarding was run. Task creation failed because an existing ancestor Beads database lacks its issue prefix; non-destructive initialization refused to overwrite that existing database. The database was left intact. The tracking file records this limitation and the remaining integration task.

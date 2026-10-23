# Nested menu labels follow-up

Installed build browser-nonsemantic-controls-20261023.3, extension 0.2.23.

Some menus expose a semantic wrapper but attach activation to an inner anchor. The opt-in snapshot now retains observed inner labels beneath menu, menuitem, listbox and option wrappers. Native buttons still take priority. No new permissions, arbitrary scripts, private framework state, or foreground automation are used.

This is an incremental patch on the exact .2 installed source listed in manifest.json, not a patch on a pristine main branch. All prior unrelated working-tree edits are excluded. Apply only after matching before hashes. The patch was applied to a temporary exact-baseline copy and every resulting candidate hash matched the tested source.

Fifteen disposable-profile browser tests passed, including the new inner-menu-label test. Syntax, background Chrome, media, video input, open shadow and layout checks also passed. The full npm test suite was not rerun for this small follow-up; do not substitute the prior .2 full-suite result.

Authenticated acceptance successfully used the previously inaccessible inner menu link to configure a time-on-page rule. No account identifiers, customer information or conversation snapshots are included here.

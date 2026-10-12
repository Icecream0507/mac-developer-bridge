#!/usr/bin/env python3
"""Hash-gated source patch; never reloads Chrome or restarts any process."""
from pathlib import Path, PurePosixPath
import datetime
import hashlib
import json
import shutil
import stat
import subprocess
import sys
import tempfile

ARTIFACT = Path(__file__).resolve().parent
MANIFEST = json.loads((ARTIFACT / "manifest.json").read_text())
PATCH = ARTIFACT / "snapshot-layout-only.patch"

def fail(message):
    raise SystemExit(message)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def target(root, relative):
    rel = PurePosixPath(relative)
    if rel.is_absolute() or ".." in rel.parts or "." in rel.parts or not rel.parts:
        fail("Unsafe manifest path")
    current = root
    for part in rel.parts:
        current = current / part
        if current.is_symlink():
            fail("Symlink target refused: " + relative)
    return current

def file_hash(root, relative):
    path = target(root, relative)
    if not path.exists():
        return None
    if not stat.S_ISREG(path.stat().st_mode):
        fail("Non-regular target refused: " + relative)
    return digest(path)

def verify(root, state):
    key = "before_sha256" if state == "baseline" else "candidate_sha256"
    for change in MANIFEST["changes"]:
        actual = file_hash(root, change["path"])
        if actual != change[key]:
            fail("Exact " + state + " hash mismatch: " + change["path"])
    for relative, expected in MANIFEST["unchanged_active_prerequisites"].items():
        if file_hash(root, relative) != expected:
            fail("Unchanged prerequisite hash mismatch: " + relative)

def git_apply(root, *flags):
    result = subprocess.run(
        ["git", "apply", "--whitespace=error", *flags, str(PATCH)],
        cwd=root, capture_output=True, text=True,
    )
    if result.returncode:
        fail("git apply refused the reviewed patch: " + result.stderr.strip())

def roundtrip(root):
    with tempfile.TemporaryDirectory(prefix="mdb-layout-verify-") as temporary:
        stage = Path(temporary)
        for change in MANIFEST["changes"]:
            if change["before_sha256"] is not None:
                source = target(root, change["path"])
                destination = target(stage, change["path"])
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
        git_apply(stage, "--check")
        git_apply(stage)
        expected_files = {change["path"] for change in MANIFEST["changes"]}
        actual_files = {path.relative_to(stage).as_posix() for path in stage.rglob("*") if path.is_file() or path.is_symlink()}
        if actual_files != expected_files:
            fail("Patch modifies paths outside the manifest")
        for change in MANIFEST["changes"]:
            if file_hash(stage, change["path"]) != change["candidate_sha256"]:
                fail("Candidate staging hash mismatch: " + change["path"])
        git_apply(stage, "--reverse", "--check")
        git_apply(stage, "--reverse")
        for change in MANIFEST["changes"]:
            if file_hash(stage, change["path"]) != change["before_sha256"]:
                fail("Reverse staging hash mismatch: " + change["path"])

def main():
    if len(sys.argv) != 3 or sys.argv[1] not in {"check", "apply", "installed"}:
        fail("Usage: python3 verify_apply.py check|apply|installed /path/to/checkout")
    mode = sys.argv[1]
    root = Path(sys.argv[2]).resolve(strict=True)
    if not root.is_dir():
        fail("Target must be a directory")
    paths = [change["path"] for change in MANIFEST["changes"]]
    if len(paths) != len(set(paths)):
        fail("Duplicate manifest paths")
    if digest(PATCH) != MANIFEST["patch_sha256"]:
        fail("Reviewed patch hash mismatch")
    for relative in paths:
        target(root, relative)
    if mode == "installed":
        verify(root, "candidate")
        print(json.dumps({"candidate_source_hashes_match": True, "runtime_readiness_verified": False}))
        return
    verify(root, "baseline")
    roundtrip(root)
    verify(root, "baseline")
    git_apply(root, "--check")
    if mode == "check":
        print(json.dumps({"baseline_hashes_match": True, "patch_roundtrip_verified": True, "target_modified": False}))
        return
    # Explicit apply mode changes only the reviewed source files. Quiet-boundary
    # coordination and the supported reload remain the caller's responsibility.
    verify(root, "baseline")
    git_apply(root)
    verify(root, "candidate")
    receipt = {
        "applied_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "state": "candidate_sources_applied",
        "patch_sha256": MANIFEST["patch_sha256"],
        "release": MANIFEST["release"],
        "candidate_sha256": {change["path"]: change["candidate_sha256"] for change in MANIFEST["changes"]},
        "no_reload_or_process_restart": True,
        "runtime_readiness_verified": False,
    }
    (ARTIFACT / "source_apply_receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))

if __name__ == "__main__":
    main()

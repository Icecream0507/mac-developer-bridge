#!/usr/bin/env python3
"""Verify or apply this exact-baseline patch; never reload, deploy, or send data."""
import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import tempfile

ARTIFACT = Path(__file__).resolve().parent


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(root, relative):
    parts = PurePosixPath(relative).parts
    if not parts or PurePosixPath(relative).is_absolute() or any(p in ("", ".", "..") for p in parts):
        raise ValueError("Invalid relative path in artifact metadata")
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Symlink rejected: " + relative)
    return current


def checked_bytes(root, expected):
    values = {}
    for relative, wanted in expected.items():
        target = safe_path(root, relative)
        if wanted is None:
            if os.path.lexists(target):
                raise ValueError("Expected absent file: " + relative)
            continue
        if not target.exists() or not stat.S_ISREG(target.lstat().st_mode):
            raise ValueError("Expected regular file: " + relative)
        data = target.read_bytes()
        if digest(data) != wanted:
            raise ValueError("SHA-256 mismatch: " + relative)
        values[relative] = data
    return values


def write_snapshot(root, values):
    for relative, data in values.items():
        target = safe_path(root, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def git_apply(root, patch, reverse=False, check=False):
    args = ["git", "apply", "--whitespace=error-all"]
    if reverse:
        args.append("--reverse")
    if check:
        args.append("--check")
    args.append("-")
    result = subprocess.run(args, cwd=root, input=patch, capture_output=True)
    if result.returncode:
        reason = result.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError("git apply rejected the exact patch: " + reason[:2000])


def combined_patch(manifest):
    checked_bytes(ARTIFACT, manifest["artifact_sha256"])
    chunks = [safe_path(ARTIFACT, name).read_bytes() for name in manifest["patches"]]
    for target, source in manifest["additions"].items():
        text = safe_path(ARTIFACT, source).read_text(encoding="utf-8")
        header = "diff --git a/{0} b/{0}\nnew file mode 100644\n".format(target)
        delta = "".join(difflib.unified_diff(
            [], text.splitlines(keepends=True), fromfile="/dev/null", tofile="b/" + target))
        chunks.append((header + delta).encode("utf-8"))
    return b"".join(chunks)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, help="Absolute canonical runtime root")
    parser.add_argument("--mode", choices=("check", "apply", "installed"), default="check",
                        help="check/installed never modify target; apply requires exact baseline")
    args = parser.parse_args()
    target = Path(args.target)
    if not target.is_absolute() or target.resolve() != target or not target.is_dir():
        raise ValueError("Target must be an absolute canonical directory without symlink components")
    manifest = json.loads((ARTIFACT / "manifest.json").read_text())
    if manifest.get("schema_version") != 1:
        raise ValueError("Unsupported manifest schema")
    before = {name: item["before"] for name, item in manifest["before_after_sha256"].items()}
    after = {name: item["after"] for name, item in manifest["before_after_sha256"].items()}
    patch = combined_patch(manifest)
    expected = after if args.mode == "installed" else before
    source_values = checked_bytes(target, expected)
    checked_bytes(target, manifest["unchanged_prerequisite_sha256"])

    # All forward and reverse writes occur in a private disposable directory.
    # Only the seven changed files are copied; this is not a working-tree export.
    with tempfile.TemporaryDirectory(prefix="mdb-csv-patch-check-") as temporary:
        staging = Path(temporary)
        write_snapshot(staging, source_values)
        if args.mode == "installed":
            git_apply(staging, patch, reverse=True, check=True)
            git_apply(staging, patch, reverse=True)
            checked_bytes(staging, before)
            git_apply(staging, patch, check=True)
            git_apply(staging, patch)
            checked_bytes(staging, after)
        else:
            git_apply(staging, patch, check=True)
            git_apply(staging, patch)
            checked_bytes(staging, after)
            git_apply(staging, patch, reverse=True, check=True)
            git_apply(staging, patch, reverse=True)
            checked_bytes(staging, before)

    if args.mode == "apply":
        # Recheck immediately before the sole target mutation. No --reject,
        # --unsafe-paths, --3way, force, reload, or fallback is used.
        checked_bytes(target, before)
        checked_bytes(target, manifest["unchanged_prerequisite_sha256"])
        git_apply(target, patch, check=True)
        git_apply(target, patch)
        checked_bytes(target, after)
        checked_bytes(target, manifest["unchanged_prerequisite_sha256"])

    print(json.dumps({
        "artifact": manifest["artifact"], "mode": args.mode,
        "exact_hashes_verified": True, "forward_reverse_roundtrip": True,
        "changed_file_count": len(before),
        "unchanged_prerequisite_count": len(manifest["unchanged_prerequisite_sha256"]),
        "target_modified": args.mode == "apply", "reload_performed": False,
    }, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        raise SystemExit(1)

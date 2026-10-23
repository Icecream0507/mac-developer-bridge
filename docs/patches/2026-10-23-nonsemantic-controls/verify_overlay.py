#!/usr/bin/env python3
"""Verify this exact source overlay in a temporary copy; never edit the target."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", type=Path, help="Complete source tree or captured baseline directory")
    args = parser.parse_args()
    package = Path(__file__).resolve().parent
    target = args.target.expanduser().resolve(strict=True)
    manifest = json.loads((package / "manifest.json").read_text())
    patch = package / "nonsemantic-controls-only.patch"
    files = manifest["files"]
    for name in files:
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise SystemExit("Manifest contains an unsafe path")
        source = target / relative
        if source.is_symlink() or not source.is_file():
            raise SystemExit(f"Missing or symlinked source file: {name}")
    states = {name: digest(target / name) for name in files}
    before = all(states[name] == info["beforeSha256"] for name, info in files.items())
    after = all(states[name] == info["afterSha256"] for name, info in files.items())
    if not before and not after:
        raise SystemExit("Target differs from both the complete reviewed baseline and installed candidate; reconcile changes before applying")
    with tempfile.TemporaryDirectory(prefix="mdb-control-overlay-check-") as temporary:
        stage = Path(temporary)
        for name in files:
            destination = stage / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target / name, destination)
        subprocess.run(["git", "init", "-q", str(stage)], check=True, capture_output=True)
        if after:
            subprocess.run(["git", "apply", "--reverse", "--check", str(patch)], cwd=stage, check=True, capture_output=True)
            subprocess.run(["git", "apply", "--reverse", str(patch)], cwd=stage, check=True, capture_output=True)
            assert all(digest(stage / name) == info["beforeSha256"] for name, info in files.items())
        subprocess.run(["git", "apply", "--check", str(patch)], cwd=stage, check=True, capture_output=True)
        subprocess.run(["git", "apply", str(patch)], cwd=stage, check=True, capture_output=True)
        assert all(digest(stage / name) == info["afterSha256"] for name, info in files.items())
        for name in files:
            if name.endswith((".js", ".mjs")):
                subprocess.run(["node", "--check", str(stage / name)], check=True, capture_output=True)
    assert all(digest(target / name) == original for name, original in states.items())
    print(json.dumps({"verified": True, "targetState": "candidate" if after else "baseline",
                      "filesChecked": len(files), "overlayAppliedInTemporaryCopy": True,
                      "candidateHashesMatched": True, "syntaxChecksPassed": True,
                      "targetUnchanged": True, "temporaryCopyRemoved": True}, indent=2))


if __name__ == "__main__":
    main()

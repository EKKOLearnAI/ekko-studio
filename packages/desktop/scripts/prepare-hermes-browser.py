"""Stage Hermes's pinned Chromium without changing its tracked source or user config."""

import argparse
import json
from pathlib import Path
import subprocess
import sys


def prepare_browser(source: Path, target: str) -> None:
    source = source.resolve()
    manifest_path = source / "manifest.json"
    if manifest_path.exists():
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        if existing.get("studioRuntime") != 1:
            raise RuntimeError(f"Refusing to replace an unmanaged payload manifest: {manifest_path}")

    sys.path.insert(0, str(source))
    # The build interpreter already has Hermes's locked dependencies. This is
    # PM's build-owned operation, not a user install or a launch-time download.
    from pm.build_operations import prepare_tools

    prepare_tools(["chromium"], out=source / "runtime-tools", target=target)
    manifest_path.write_text(json.dumps({
        "studioRuntime": 1,
        "repo": ".",
        "venv": "venv",
        "store": "runtime-tools",
    }, indent=2) + "\n", encoding="utf-8")

    # Both files are build outputs. Retaining a clean checkout is required for
    # upstream `hermes update`; do not edit the upstream tracked .gitignore.
    exclude = subprocess.check_output(
        ["git", "rev-parse", "--git-path", "info/exclude"], cwd=source, text=True,
    ).strip()
    exclude_path = Path(exclude)
    if not exclude_path.is_absolute():
        exclude_path = source / exclude_path
    exclude_path.parent.mkdir(parents=True, exist_ok=True)
    old = exclude_path.read_text(encoding="utf-8") if exclude_path.exists() else ""
    missing = [line for line in ("/manifest.json", "/runtime-tools/") if line not in old.splitlines()]
    if missing:
        exclude_path.write_text(old.rstrip("\n") + "\n" + "\n".join(missing) + "\n", encoding="utf-8")

    from hermes_cli.browser_runtime import chromium_executable

    executable = chromium_executable(allow_override=False)
    if not executable or not Path(executable).is_relative_to(source / "runtime-tools"):
        raise RuntimeError(f"Hermes did not select its bundled Chromium: {executable}")
    print(f"Hermes PM Chromium ready: {executable}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--target", required=True)
    args = parser.parse_args()
    prepare_browser(args.source, args.target)

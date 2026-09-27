"""Build a private Windows handoff folder from a clean commit, installer and verified deliveries."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import runpy
import shutil
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--uv", type=Path, required=True)
    args = parser.parse_args()
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT).strip():
        raise RuntimeError("Commit the source before creating a versioned transfer folder")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    version = subprocess.check_output([str(args.uv), "--version"], text=True).split()[1]
    if not all(part.isdecimal() for part in version.split(".")):
        raise ValueError("Expected a released uv version")
    licenses = {}
    for name in ("LICENSE-MIT", "LICENSE-APACHE"):
        with urllib.request.urlopen(f"https://raw.githubusercontent.com/astral-sh/uv/{version}/{name}", timeout=60) as response:
            licenses[name] = response.read()
    output = args.output.resolve()
    if output.is_relative_to(ROOT) and not any(output.is_relative_to(ROOT/name) for name in ("outputs", "work")):
        raise ValueError("Private models must stay outside the repo or under ignored work/outputs")
    output.mkdir(parents=True, exist_ok=False)
    integrity = runpy.run_path(str(ROOT/"scripts/prepare-imaging-packages.py"))
    copies = {"EXMO-Atlas-Setup.exe": args.installer, "tools/uv.exe": args.uv,
              "README.md": ROOT/"docs/EXMO_DESKTOP_TRANSFER.md", "LICENSE": ROOT/"LICENSE",
              "desktop/imaging-palette.json": ROOT/"dist-desktop/imaging-palette.json"}
    for name in ("prepare-imaging.ps1", "prepare-imaging-packages.py", "validate-imaging-engine.py", "validate-imaging-transfer.py", "install-desktop-transfer.ps1"):
        copies[f"scripts/{name}"] = ROOT/"scripts"/name
    for path in sorted((ROOT/"desktop").glob("*.py")) + sorted((ROOT/"desktop").glob("requirements-*.txt")):
        copies[f"desktop/{path.name}"] = path
    for name in integrity["ARCHIVES"]:
        copies[f"models/{name}"] = args.source/name
    for name, source in copies.items():
        print(f"Copying {name}...", flush=True)
        destination = output/name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        if name.startswith("models/") and integrity["digest"](destination) != integrity["ARCHIVES"][Path(name).name]:
            raise ValueError(f"Private archive mismatch: {name}")
    for name, content in licenses.items():
        (output/f"tools/uv-{name}").write_bytes(content)
    (output/"tools/uv-source.txt").write_text(f"uv {version}\nhttps://github.com/astral-sh/uv/tree/{version}\nUnmodified executable, distributed under MIT OR Apache-2.0; licenses included.\n", encoding="utf8")
    for name, switch in (("01-Install.cmd", ""), ("02-Verify-workflows.cmd", "-WorkflowCheck")):
        (output/name).write_text('@echo off\nsetlocal\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\install-desktop-transfer.ps1" '+switch+'\nif errorlevel 1 (\n  echo FAILED. Review the error above.\n  pause\n  exit /b 1\n)\npause\n',encoding="ascii",newline="\r\n")
    subprocess.run(["git", "archive", "--format=zip", f"--output={output/'source.zip'}", commit], cwd=ROOT, check=True)
    files = [{"path": path.relative_to(output).as_posix(), "bytes": path.stat().st_size, "sha256": integrity["digest"](path)}
             for path in sorted(output.rglob("*")) if path.is_file()]
    manifest = {"schema": 1, "sourceCommit": commit, "builtAt": datetime.now(timezone.utc).isoformat(), "platform": "Windows x64",
                "firstSetupRequiresInternet": True, "includesExistingPatientLibrary": False, "uvVersion": version,
                "files": files, "totalPayloadBytes": sum(row["bytes"] for row in files)}
    (output/"transfer-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf8")
    print(f"Transfer folder: {output}\nSource: {commit}\nPayload bytes: {manifest['totalPayloadBytes']}")


if __name__ == "__main__":
    main()

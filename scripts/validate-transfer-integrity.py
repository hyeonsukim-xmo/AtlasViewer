"""Exercise transfer guards and a failed setup without running installers or touching real userData."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def run(script, *args, appdata):
    return subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), *map(str, args)],
                          capture_output=True, text=True, encoding="utf8", errors="replace", timeout=30,
                          env={**os.environ, "APPDATA": str(appdata)})


def main():
    with tempfile.TemporaryDirectory(prefix="exmo-transfer-check-") as temporary:
        folder = Path(temporary)
        appdata = folder/"private appdata"
        config = appdata/"EXMO Atlas/engine.json"
        config.parent.mkdir(parents=True)
        original = b'{"root":"existing-engine-must-not-change"}'
        config.write_bytes(original)
        bundle = folder/"transfer with spaces"
        (bundle/"scripts").mkdir(parents=True)
        installer = bundle/"scripts/install-desktop-transfer.ps1"
        shutil.copyfile(ROOT/"scripts/install-desktop-transfer.ps1", installer)
        names = ["EXMO-Atlas-Setup.exe", "tools/uv.exe", "scripts/prepare-imaging.ps1", "scripts/prepare-imaging-packages.py",
                 "scripts/validate-imaging-engine.py", "scripts/validate-imaging-transfer.py", "desktop/imaging-palette.json",
                 "desktop/imaging-worker.py", "desktop/classifier-worker.py", "desktop/model-runner.py",
                 "desktop/requirements-ct.txt", "desktop/requirements-mri.txt", "desktop/requirements-ap.txt", "desktop/requirements-lat.txt",
                 "models/EXMO_CT.zip", "models/EXMO_MRI.tar.gz", "models/EXMO_XRAY.zip"]
        entries = []
        for name in names:
            file = bundle/name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"inert fixture; must never be executed")
            entries.append({"path": name, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
        manifest = bundle/"transfer-manifest.json"
        value = {"schema": 1, "sourceCommit": "a"*40, "files": entries}
        manifest.write_text(json.dumps(value), encoding="utf8")
        assert run(installer, "-VerifyOnly", appdata=appdata).returncode == 0
        payload = bundle/names[0]
        payload.write_bytes(b"corrupted")
        assert run(installer, "-VerifyOnly", appdata=appdata).returncode != 0, "Corruption was accepted"
        payload.unlink()
        assert run(installer, "-VerifyOnly", appdata=appdata).returncode != 0, "Missing file was accepted"
        payload.write_bytes(b"inert fixture; must never be executed")
        outside = folder/"outside.txt"
        outside.write_bytes(b"do not read")
        value["files"] = [*entries, {"path": "../outside.txt", "sha256": hashlib.sha256(outside.read_bytes()).hexdigest()}]
        manifest.write_text(json.dumps(value), encoding="utf8")
        assert run(installer, "-VerifyOnly", appdata=appdata).returncode != 0, "Path traversal was accepted"
        value["files"] = [entry for entry in entries if entry["path"] != "desktop/model-runner.py"]
        manifest.write_text(json.dumps(value), encoding="utf8")
        assert run(installer, "-VerifyOnly", appdata=appdata).returncode != 0, "Incomplete manifest was accepted"
        # A failed runtime download must not register an unprepared engine.
        failing_uv = folder/"failing-uv.cmd"
        failing_uv.write_text("@exit /b 7\n", encoding="ascii")
        failed = run(ROOT/"scripts/prepare-imaging.ps1", "-Source", bundle/"models", "-EngineRoot", folder/"failed engine",
                     "-UvPath", failing_uv, appdata=appdata)
        assert failed.returncode != 0, "Failed runtime setup returned success"
        assert config.read_bytes() == original, "Validation or failed setup changed existing app configuration"
    print("PASS: complete copy, corruption/missing/path-traversal/incomplete-manifest rejection; failed setup preserves app configuration")


if __name__ == "__main__":
    main()

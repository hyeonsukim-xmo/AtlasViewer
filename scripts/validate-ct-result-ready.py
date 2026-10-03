"""Verify completed CT output through the real measurement/3D/overlay worker.

Only writes beside the isolated result; does not publish into the desktop library.
"""
import argparse
import base64
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import sys
import time
import uuid
sys.dont_write_bytecode = True
parser = argparse.ArgumentParser()
parser.add_argument("--engine-root", type=Path, required=True)
parser.add_argument("--record", type=Path, required=True)
parser.add_argument("--result", type=Path, required=True)
parser.add_argument("--report", type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("worker", root / "desktop/imaging-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
record = json.loads(args.record.read_text(encoding="utf-8"))
palette = {r["id"]: r for r in json.loads((root / "dist-desktop/imaging-palette.json").read_text())}
started = time.monotonic()
print("Preparing measurements and 3D", flush=True)
result = worker.finalize({"id": str(uuid.uuid4()), "record": record, "result": str(args.result),
    "createdAt": datetime.now(timezone.utc).isoformat()}, args.engine_root, palette)
finalize_seconds = time.monotonic() - started
assert Path(result["mesh"]).read_bytes()[:4] == b"glTF"
assert all(worker.np.isfinite(r["value"]) and r["value"] >= 0 for r in result["summary"]["rows"])
for view in ("axial", "coronal", "sagittal"):
    preview = worker.preview({"record": record, "mask": result["mask"], "sideMask": result["sideMask"], "view": view})
    assert base64.b64decode(preview["image"].split(",", 1)[1]).startswith(b"\x89PNG\r\n\x1a\n")
report = {"passed": True, "scope": "measurements, geometry checks, 3D and three overlay planes; not clinical accuracy",
    "finalize_seconds": finalize_seconds, "with_preview_seconds": time.monotonic() - started,
    "model_runner_seconds": result["summary"]["seconds"], "mesh_bytes": result["summary"]["meshBytes"],
    "class_count": len(result["summary"]["rows"])}
args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report), flush=True)

"""CT NRRD header-only import and deferred validation, using a supplied CT sample."""
import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import time

import numpy as np
import SimpleITK as sitk

parser = argparse.ArgumentParser()
parser.add_argument("--engine-root", type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
output = root / "outputs/bulk-import-check"
output.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location("worker", root / "desktop/imaging-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
sample = args.engine_root / "packages/EXMO_CT/samples/EXMO_CASE_001/input_ct.nii.gz"
image = sitk.ReadImage(str(sample))
fixture = output / "fixture.nrrd"
sitk.WriteImage(image, str(fixture), True)
with tempfile.TemporaryDirectory(prefix="validation-", dir=output) as temporary:
    base = Path(temporary)
    def inspect(source, name):
        return worker.inspect({"analysis": "ct", "paths": [str(source)],
            "destination": str(base / name)}, args.engine_root, None)[0]
    start = time.monotonic()
    record = inspect(fixture, "valid")
    seconds = time.monotonic() - start
    assert record["ready"] and record["deferredValidation"]
    assert Path(record["input"]).suffix == ".nrrd"
    assert not list((base / "valid").rglob("*.nii.gz"))
    assert worker.digest(record["input"]) == worker.digest(fixture)
    try:
        worker.prepare({"record": record, "confirmed": False})
        raise AssertionError("HU confirmation bypassed")
    except worker.InputError:
        pass
    prepared = worker.prepare({"record": record, "confirmed": True})
    converted = sitk.ReadImage(prepared["input"])
    assert np.array_equal(sitk.GetArrayViewFromImage(image), sitk.GetArrayViewFromImage(converted))
    assert worker.same_geometry(image, converted)
    evidence = worker.read_json(Path(prepared["input"]).parent / "hu_evidence.json")
    assert evidence["source_sha256"] == worker.digest(prepared["input"])
    assert Path(record["input"]).exists(), "Original snapshot must remain usable for preview"
    constant = base / "constant.nrrd"
    sitk.WriteImage(sitk.Image([8, 9, 10], sitk.sitkInt16), str(constant), True)
    constant_record = inspect(constant, "constant-import")
    assert constant_record["ready"] and constant_record["deferredValidation"]
    try:
        worker.prepare({"record": constant_record, "confirmed": True})
        raise AssertionError("Constant volume accepted for inference")
    except worker.InputError:
        pass
    corrupt = base / "corrupt.nrrd"
    data = fixture.read_bytes()
    boundary = data.find(bytes([10, 10])) + 2
    assert boundary > 1
    corrupt.write_bytes(data[:boundary] + b"broken compressed payload")
    broken = inspect(corrupt, "corrupt-import")
    if broken["ready"]:
        try:
            worker.prepare({"record": broken, "confirmed": True})
        except Exception:
            pass
        else:
            raise AssertionError("Corrupt volume accepted for inference")
    report = {"passed": True, "shape": list(image.GetSize()), "fixtureBytes": fixture.stat().st_size,
        "headerImportSeconds": seconds, "checks": ["NRRD preserved", "HU confirmation enforced",
        "voxel and physical geometry parity", "evidence hash bound to prepared input",
        "constant and corrupt volumes rejected before inference"]}
    (output / "validation-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))

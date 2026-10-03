"""Compare completed AP/LAT CUDA sample masks with prior validated outputs."""
import argparse
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True
import nrrd
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument("--baseline", type=Path, required=True)
parser.add_argument("--current", type=Path, required=True)
args = parser.parse_args()
reports = []
for name in ("ap", "lat_lt", "lat_rt"):
    base, current = args.baseline / name, args.current / name
    previous_job = json.loads((base / "job.json").read_text())
    current_job = json.loads((current / "job.json").read_text())
    assert previous_job["input"] == current_job["input"]
    identity = json.loads((current / "output/desktop-complete.json").read_text())
    assert identity["execution"]["device"] == "cuda:0"
    assert identity["execution"]["peak_gpu_memory_bytes"] > 0
    mask = "mask.seg.nrrd" if name == "ap" else "mask.nrrd"
    a, ah = nrrd.read(str(base / "output" / mask))
    b, bh = nrrd.read(str(current / "output" / mask))
    assert a.shape == b.shape
    for key in ("space", "space directions", "space origin", "space units", "kinds"):
        assert (key in ah) == (key in bh)
        if key in ah:
            if np.asarray(ah[key]).dtype.kind in "fiu":
                assert np.array_equal(ah[key], bh[key], equal_nan=True), key
            else:
                assert np.array_equal(ah[key], bh[key]), key
    different = int(np.count_nonzero(a != b))
    reports.append({"model": name, "different_voxels": different, "voxels": int(a.size),
        "exact_match": different == 0, "seconds": identity["seconds"], "execution": identity["execution"]})
report = {"scope": "GPU sample execution and repeatability, not clinical accuracy", "results": reports}
(args.current / "xray-comparison.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report), flush=True)

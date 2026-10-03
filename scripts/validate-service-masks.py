"""Numerical regression checks, not clinical accuracy validation."""
import argparse
import json
import os
from pathlib import Path
import numpy as np
import SimpleITK as sitk

parser = argparse.ArgumentParser()
parser.add_argument("--storage", type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
engine = Path(os.environ["LOCALAPPDATA"]) / "EXMO Atlas/engine"
rows = []
for name in ("ap", "lat_lt", "lat_rt", "mri"):
    if name == "mri":
        case = "a25250bf1143426cb4270afb3337179c"
        base = engine / "validation/transfer-20260928-042706-ce6e26/mri/output" / case
        current = args.storage / "mri" / case
        previous_qc, current_qc = [json.loads((p / "qc.json").read_text()) for p in (base, current)]
        for key in ("model_sha256", "source_sha256", "native_geometry", "tta"):
            assert previous_qc[key] == current_qc[key], key
        masks = ["raw/mask.nrrd", "pp500/mask.nrrd"]
    else:
        base = root / "outputs/all-gpu-validation" / name / "output"
        current = args.storage / name
        masks = ["mask.seg.nrrd" if name == "ap" else "mask.nrrd"]
    for mask in masks:
        a, b = [sitk.ReadImage(str(p / mask)) for p in (base, current)]
        assert a.GetSize() == b.GetSize()
        assert a.GetSpacing() == b.GetSpacing()
        assert a.GetDirection() == b.GetDirection()
        assert a.GetOrigin() == b.GetOrigin()
        expected, actual = sitk.GetArrayFromImage(a), sitk.GetArrayFromImage(b)
        different = int(np.count_nonzero(expected != actual))
        row = {"model": name, "mask": mask, "different_voxels": different, "voxels": int(actual.size)}
        rows.append(row)
        # Regression alarm only: not an acceptance criterion for clinical use.
        assert different / actual.size < 0.001, row
        if name == "ap":
            assert different == 0, row
report = {"passed": True, "clinical_validation": False, "comparisons": rows}
(args.storage / "mask-comparison.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report))

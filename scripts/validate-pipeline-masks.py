"""Compare pipelined CT outputs with the previously validated sequential GPU run."""
import argparse
import json
from pathlib import Path
import nibabel as nib
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument("--storage", type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
baseline = root / "outputs/ct-speed-validation/sample-final/output/case_mdkbkbgpgjllbbmgjgbahioobogngahb"
reference = nib.load(baseline / "mask.nii.gz")
expected = np.asarray(reference.dataobj, dtype=np.uint8)
provenance = json.loads((baseline / "provenance.json").read_text())
rows = []
for publication in (args.storage / "runs").glob("*/published.json"):
    result = Path(json.loads(publication.read_text())["result"])
    actual = nib.load(result / "mask.nii.gz")
    current = json.loads((result / "provenance.json").read_text())
    for key in ("source_ct_sha256", "model_sha256", "recipe_sha256", "ontology_sha256", "geometry", "precision", "tta", "pp"):
        assert current[key] == provenance[key], key
    assert actual.shape == reference.shape
    assert np.array_equal(actual.affine, reference.affine)
    mismatches = int(np.count_nonzero(expected != np.asarray(actual.dataobj, dtype=np.uint8)))
    rows.append({"result": str(result), "different_voxels": mismatches, "voxels": int(expected.size)})
    assert mismatches == 0, rows[-1]
assert len(rows) == 2
report = {"passed": True, "clinical_validation": False, "comparison": "sequential GPU versus overlapped GPU/CPU", "cases": rows}
(args.storage / "mask-comparison.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report))

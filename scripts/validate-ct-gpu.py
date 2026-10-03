"""Compare completed CT GPU/CPU outputs without changing either result.

Reports numerical differences; this is engineering validation, not clinical approval.
Run with the CT environment's Python and --cpu RESULT --gpu RESULT --report FILE.
"""
import argparse
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
import nibabel as nib
import numpy as np


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cpu", type=Path, required=True)
    parser.add_argument("--gpu", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    cpu_prov, gpu_prov = [read(p / "provenance.json") for p in (args.cpu, args.gpu)]
    for key in ("source_ct_sha256", "model_sha256", "recipe_sha256", "ontology_sha256", "geometry", "precision", "tta", "pp"):
        assert cpu_prov[key] == gpu_prov[key], f"Incompatible comparison: {key}"
    assert cpu_prov["device"] == "cpu"
    assert gpu_prov["device"] == "cuda:0"
    cpu_img, gpu_img = [nib.load(p / "mask.nii.gz") for p in (args.cpu, args.gpu)]
    assert cpu_img.shape == gpu_img.shape
    assert np.array_equal(cpu_img.affine, gpu_img.affine)
    cpu = np.asarray(cpu_img.dataobj, dtype=np.uint8)
    gpu = np.asarray(gpu_img.dataobj, dtype=np.uint8)
    assert np.isin(gpu, np.arange(33)).all()
    volume_ml = abs(np.linalg.det(gpu_img.affine[:3, :3])) / 1000
    confusion = np.bincount((cpu.astype(np.int16) * 33 + gpu).ravel(), minlength=33*33).reshape(33, 33)
    rows = []
    for label in range(1, 33):
        a, b, intersection = int(confusion[label].sum()), int(confusion[:, label].sum()), int(confusion[label, label])
        rows.append({"label": label, "cpu_voxels": a, "gpu_voxels": b,
                     "dice": 2 * intersection / (a + b) if a + b else 1,
                     "volume_difference_ml": (b - a) * volume_ml})
    gpu_complete = read(args.gpu / "desktop-complete.json")
    assert gpu_complete["execution"]["device"] == "cuda:0"
    assert gpu_complete["execution"]["peak_gpu_memory_bytes"] > 0
    differences = int(np.count_nonzero(cpu != gpu))
    report = {"geometry_and_recipe_match": True, "clinical_validation": False,
              "voxels": int(cpu.size), "different_voxels": differences,
              "agreement_fraction": 1 - differences / cpu.size,
              "minimum_foreground_dice": min(r["dice"] for r in rows),
              "maximum_absolute_volume_difference_ml": max(abs(r["volume_difference_ml"]) for r in rows),
              "cpu_seconds": read(args.cpu / "desktop-complete.json")["seconds"],
              "gpu_seconds": gpu_complete["seconds"], "execution": gpu_complete["execution"], "classes": rows}
    args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "classes"}), flush=True)


if __name__ == "__main__":
    main()

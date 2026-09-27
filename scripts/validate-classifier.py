"""Private worker parity and rejected-input checks; only synthetic images are used."""
import json
import os
from pathlib import Path
import subprocess
import sys

import numpy as np
import nrrd
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, SecondaryCaptureImageStorage, generate_uid

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "work/modality-integration/packages/EXMO_XRAY/classification"
OUTPUT = ROOT / "outputs/xray-check"
sys.path.insert(0, str(BUNDLE))
from pipeline import ViewClassificationPipeline


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    array = np.arange(512 * 256, dtype=np.uint16).reshape(512, 256) % 4096
    nrrd.write(str(OUTPUT / "synthetic-integration-check.nrrd"), array)
    meta = FileMetaDataset()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    ds = FileDataset("", {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.Modality = "DX"
    ds.SeriesDescription = "Synthetic integration check - not a patient image"
    ds.Rows, ds.Columns = array.shape
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 16
    ds.BitsStored = 12
    ds.HighBit = 11
    ds.PixelRepresentation = 0
    ds.PixelData = array.astype("<u2").tobytes()
    ds.save_as(OUTPUT / "synthetic-integration-check.dcm", enforce_file_format=True)
    ds.Modality = "CT"
    ds.save_as(OUTPUT / "unsupported-ct.dcm", enforce_file_format=True)
    nrrd.write(str(OUTPUT / "unsupported-volume.nrrd"), np.arange(1000, dtype=np.uint16).reshape(10, 10, 10))
    nrrd.write(str(OUTPUT / "blank.nrrd"), np.zeros((100, 100), dtype=np.uint16))
    (OUTPUT / "corrupt.nrrd").write_text("not a medical image")
    (OUTPUT / "detached.nrrd").write_text("NRRD0005\ntype: ushort\ndimension: 2\nsizes: 2 2\nencoding: raw\nendian: little\ndata file: ../must-not-read.raw\n\n")

    requests = []
    expected = {}
    pipeline = ViewClassificationPipeline()
    for suffix in ("dcm", "nrrd"):
        file = OUTPUT / f"synthetic-integration-check.{suffix}"
        expected[suffix] = pipeline.predict(file)
        for operation in ("preview", "classify"):
            requests.append({"id": f"{suffix}-{operation}", "operation": operation, "path": str(file)})
    pipeline.models.clear()
    for name in ("unsupported-ct.dcm", "unsupported-volume.nrrd", "blank.nrrd", "corrupt.nrrd", "detached.nrrd"):
        requests.append({"id": name, "operation": "classify", "path": str(OUTPUT / name)})
    process = subprocess.run([sys.executable, str(ROOT / "desktop/classifier-worker.py"), str(BUNDLE)],
        input="".join(json.dumps(request) + "\n" for request in requests),
        capture_output=True, text=True, encoding="utf-8", timeout=120,
        env={**os.environ, "PYTHONPATH": str(BUNDLE), "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"})
    assert process.returncode == 0, process.stderr[-1500:]
    results = [json.loads(line) for line in process.stdout.splitlines()]
    assert len(results) == len(requests), "Every request must receive exactly one response"
    for response in results:
        if response["id"].endswith("-preview"):
            assert response["result"]["image"].startswith("data:image/png;base64,")
            assert response["result"]["metadata"]["width"] == 256
        elif response["id"].endswith("-classify"):
            value = response["result"]
            original = expected[response["id"].split("-")[0]]
            for field in ("predicted_label", "segmentation_view", "status", "route_to_segmentation"):
                assert value[field] == original[field], (field, value, original)
            for label, probability in original["probabilities"].items():
                assert abs(value["probabilities"][label] - probability) < 1e-7
            assert abs(sum(value["probabilities"].values()) - 1) < 1e-7
            assert "feature_cache" not in value and "input_file" not in value
        else:
            assert "error" in response, response["id"]
            assert str(ROOT) not in response["error"] and "must-not-read" not in response["error"]
    (OUTPUT / "expected.json").write_text(json.dumps(expected, indent=2), encoding="utf-8")
    print("PASS: private worker matches original DICOM/NRRD predictions and scores; previews, CT/volume/blank/corrupt/detached rejection. Synthetic inputs only.")


if __name__ == "__main__":
    main()

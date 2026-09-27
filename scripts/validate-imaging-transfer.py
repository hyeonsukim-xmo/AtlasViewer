"""Run delivered samples through the actual Desktop adapters in a separate private test store."""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import time
from types import SimpleNamespace
import uuid

import numpy as np
import SimpleITK as sitk

ROOT = Path(__file__).resolve().parents[1]
CASES = {
    "ct": ("ct", None, "EXMO_CT/samples/EXMO_CASE_001/input_ct.nii.gz", "EXMO_CT/results/EXMO_CASE_001/mask.nii.gz"),
    "mri": ("mri", None, "EXMO_MRI/samples/sample_01/W.nrrd", "EXMO_MRI/samples/sample_01/raw/mask.nrrd"),
    "ap": ("xray", "AP", "EXMO_XRAY/samples/AP/AP_01/input.nrrd", "EXMO_XRAY/outputs/reference/AP/AP_01/mask.seg.nrrd"),
    "lat_lt": ("xray", "LAT_LT", "EXMO_XRAY/samples/LAT_LT/LAT_LT_01/input.nrrd", "EXMO_XRAY/outputs/reference/LAT_LT/LAT_LT_01/mask.seg.nrrd"),
    "lat_rt": ("xray", "LAT_RT", "EXMO_XRAY/samples/LAT_RT/LAT_RT_01/input.nrrd", "EXMO_XRAY/outputs/reference/LAT_RT/LAT_RT_01/mask.seg.nrrd"),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine-root", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    parser.add_argument("--cases", nargs="+", choices=tuple(CASES), default=list(CASES))
    args = parser.parse_args()
    engine = args.engine_root.resolve()
    output = (args.output or engine/"validation"/(datetime.now().strftime("transfer-%Y%m%d-%H%M%S-")+uuid.uuid4().hex[:6])).resolve()
    output.mkdir(parents=True, exist_ok=False)
    worker = SimpleNamespace(**runpy.run_path(str(ROOT/"desktop/imaging-worker.py")))
    classification = engine/"packages/EXMO_XRAY/classification"
    sys.path.insert(0, str(classification))
    classifier = SimpleNamespace(**runpy.run_path(str(ROOT/"desktop/classifier-worker.py")))
    classifier.engine.DEFAULT_DICOM_CACHE = classification/"models/dicom/training_features_4class_dicom_260711_corrected.npz"
    classifier.engine.DEFAULT_NRRD_CACHE = classification/"models/nrrd/training_features_4class_nrrd_260711.npz"
    classifier.pipeline = classifier.ViewClassificationPipeline(min_confidence=.4)
    palette_path = ROOT/"desktop/imaging-palette.json"
    if not palette_path.exists():
        palette_path = ROOT/"dist-desktop/imaging-palette.json"
    palette = {row["id"]: row for row in json.loads(palette_path.read_text(encoding="utf8"))}
    report = {"schema": 1, "startedAt": datetime.now(timezone.utc).isoformat(), "cases": [],
              "requestedCases": args.cases, "allRequestedCasesPassed": False,
              "scope": "Real sample import/classification, inference, metrics, QC, variants, PNG overlays and GLB. Numerical differences are not clinical accuracy."}
    environment = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1", "OMP_NUM_THREADS": "4", "OPENBLAS_NUM_THREADS": "2"}
    try:
        for case in args.cases:
            analysis, route, relative, baseline = CASES[case]
            print(f"START {case}: import -> inference -> measurements/overlay/3D", flush=True)
            case_root = output/case
            case_root.mkdir()
            source = engine/"packages"/relative
            original_hash = worker.digest(source)
            records = worker.inspect({"analysis": analysis, "paths": [str(source)], "names": {str(source): f"Transfer validation - {case}"},
                                      "destination": str(case_root/"import")}, engine, classifier)
            assert len(records) == 1 and records[0]["ready"], records
            record = records[0]
            assert record.get("confirmation") is None, "Delivered sample input evidence was not recognized"
            assert record.get("classification", {}).get("route_to_segmentation") == route
            worker.prepare({"record": record, "confirmed": False})
            views = ("axial",) if analysis == "xray" else ("axial", "coronal", "sagittal")
            for view in views:
                preview = worker.preview({"record": record, "view": view})
                assert base64.b64decode(preview["image"].split(",",1)[1]).startswith(b"\x89PNG\r\n\x1a\n")
            job = {"id": record["id"], "input": record["input"], "analysis": analysis, "route": route,
                   "device": "cuda:0" if args.device == "cuda" else "cpu", "output": str(case_root/"output")}
            job_path = case_root/"job.json"
            worker.write_json(job_path, job)
            runtime = analysis if analysis != "xray" else "ap" if route == "AP" else "lat"
            started = time.monotonic()
            log_path = case_root/"inference-private.log"
            print(f"Running {case}; detailed progress: {log_path}", flush=True)
            with log_path.open("w", encoding="utf8") as log:
                process = subprocess.Popen([str(engine/f"envs/{runtime}/Scripts/python.exe"), "-X", "utf8", str(ROOT/"desktop/model-runner.py"),
                                            "--engine-root", str(engine), "--job", str(job_path)], stdout=log, stderr=subprocess.STDOUT, env=environment)
                try:
                    code = process.wait(timeout=7200)
                except BaseException:
                    if process.poll() is None:
                        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
                    raise
            if code:
                raise RuntimeError(f"{case} inference failed ({code}); see {log_path}")
            complete = None
            for line in log_path.read_text(encoding="utf8", errors="replace").splitlines():
                try:
                    event = json.loads(line)
                    if event.get("exmo") and event.get("stage") == "complete":
                        complete = event
                except (ValueError, AttributeError):
                    pass
            assert complete and complete.get("complete"), f"No completion record for {case}"
            result = Path(complete["result"])
            assert result.is_relative_to(case_root) and (result/"desktop-complete.json").is_file()
            ident = str(uuid.uuid4())
            created = datetime.now(timezone.utc).isoformat()
            row = {"case": case, "inferenceSeconds": round(time.monotonic()-started, 2), "variants": []}
            for variant in (("raw", "pp500", "strong") if analysis == "mri" else ("raw",)):
                publication = worker.finalize({"id": ident, "record": record, "result": str(result), "variant": variant, "createdAt": created}, engine, palette)
                summary = publication["summary"]
                assert summary["rows"] and all(np.isfinite(r["value"]) and r["value"] >= 0 for r in summary["rows"])
                if analysis != "xray":
                    assert Path(publication["mesh"]).read_bytes()[:4] == b"glTF", "Missing GLB"
                for view in views:
                    overlay = worker.preview({"record": record, "mask": publication["mask"], "sideMask": publication["sideMask"],
                                              "rows": summary["rows"], "view": view})
                    payload = base64.b64decode(overlay["image"].split(",",1)[1])
                    assert payload.startswith(b"\x89PNG\r\n\x1a\n")
                    (case_root/f"{variant}-{view}.png").write_bytes(payload)
                row["variants"].append({"name": variant, "classes": len(summary["rows"]), "unit": summary["unit"], "meshBytes": summary["meshBytes"]})
                if variant == "raw":
                    native = sitk.ReadImage(publication["mask"])
                    reference = sitk.ReadImage(str(engine/"packages"/baseline))
                    assert worker.same_geometry(native, reference), "Reference and output geometry differ"
                    actual, expected = sitk.GetArrayFromImage(native), sitk.GetArrayFromImage(reference)
                    differences = int(np.count_nonzero(actual != expected))
                    row["referenceComparison"] = {"differentVoxels": differences, "totalVoxels": int(actual.size),
                                                  "fraction": differences/actual.size, "exactMatch": differences == 0,
                                                  "interpretation": "Reproduction comparison, not ground-truth accuracy; review cross-hardware differences"}
                    del actual, expected, native, reference
            assert worker.digest(source) == original_hash, "Delivered input was modified"
            worker.clear_image_cache()
            row["passed"] = True
            report["cases"].append(row)
            worker.write_json(output/"workflow-check.json", report)
            print(f"PASS {case}: {json.dumps(row)}", flush=True)
        report["allRequestedCasesPassed"] = True
    except BaseException as error:
        report["error"] = str(error) or type(error).__name__
        raise
    finally:
        report["finishedAt"] = datetime.now(timezone.utc).isoformat()
        worker.write_json(output/"workflow-check.json", report)
        print(f"Workflow report: {output/'workflow-check.json'}", flush=True)


if __name__ == "__main__":
    main()

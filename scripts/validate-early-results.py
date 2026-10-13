"""Real geometry/mesh regression without inference; optionally replay a saved MRI result."""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import time
import numpy as np
import SimpleITK as sitk

ROOT = Path(__file__).resolve().parents[1]

def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "desktop" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", action="store_true")
    args = parser.parse_args()
    worker, runner = load("imaging-worker"), load("model-runner")
    # Nested instrumentation must not count export's nested measurements twice.
    runner._context.timing = {"seconds": {}, "stack": []}
    clock = iter([0., 2., 5., 9.])
    monotonic = runner.time.monotonic
    runner.time.monotonic = lambda: next(clock)
    try:
        with runner.measured("export"):
            with runner.measured("measurement"):
                pass
    finally:
        runner.time.monotonic = monotonic
    assert runner._context.timing["seconds"] == {"measurement": 3., "export": 6.}
    events, original_emit = [], runner.emit
    runner.emit = lambda stage, **values: events.append({"stage": stage, **values})
    try:
        assert runner.observed("probe", lambda value: value)(7) == 7
        error = ValueError("test")
        def fail(): raise error
        try:
            runner.observed("failed_probe", fail)()
        except ValueError as caught:
            assert caught is error
        else:
            raise AssertionError("Instrumentation swallowed failure")
    finally:
        runner.emit = original_emit
    assert [e["stage"] for e in events] == ["operation_start", "operation_end"] * 2
    assert events[1]["succeeded"] and not events[3]["succeeded"]
    assert all(events[i]["seconds"] >= 0 and events[i]["thread_cpu_seconds"] >= 0 for i in (1, 3))
    assert not runner._context.timing["stack"] and "failed_probe" in runner._context.timing["seconds"]
    # Cloning instrumentation must retain binding/defaults without changing globals.
    def probe(value=3, *, scale=2): return abs(value) * scale
    wrapped = runner.with_globals(probe, abs=lambda value: value + 10)
    assert wrapped(-3) == 14 and probe(-3) == 6 and wrapped() == 26
    class BoundProbe:
        def call(self, value=-3): return abs(value)
    original = BoundProbe().call
    assert runner.with_globals(original, abs=lambda value: value + 10)() == 7
    assert original() == 3
    with tempfile.TemporaryDirectory(prefix="exmo-early-") as directory:
        root = Path(directory)
        result = root / "output"
        result.mkdir()
        if args.sample:
            engine = ROOT / "work/modality-integration"
            source = engine / "validation/mri-run-01/sample_01"
            # No cached derived meshes: measure a fresh preparation, retaining raw outputs.
            shutil.copytree(source, result, dirs_exist_ok=True, ignore=shutil.ignore_patterns("laterality-*", "desktop-result-*"))
            image_path = engine / "packages/EXMO_MRI/samples/sample_01/W.nrrd"
            analysis = "mri"
        else:
            engine = root
            ontology = root / "packages/EXMO_CT/configs"
            ontology.mkdir(parents=True)
            worker.write_json(ontology / "ontology.json", {"labels": [
                {"id": 0, "name": "background"}, {"id": 1, "name": "femoral"}, {"id": 2, "name": "sartorius"}]})
            labels = np.zeros((24, 24, 40), dtype=np.uint8)
            labels[2:22, 8:14, 3:8] = labels[2:22, 8:14, 30:35] = 1
            labels[3:21, 15:19, 4:9] = labels[3:21, 15:19, 29:34] = 2
            mask = sitk.GetImageFromArray(labels); mask.SetSpacing((2., 2., 2.))
            image_path = root / "input.nii.gz"
            sitk.WriteImage(sitk.Cast(mask, sitk.sitkFloat32), str(image_path))
            sitk.WriteImage(mask, str(result / "mask.nii.gz"))
            worker.write_json(result / "desktop-complete.json", {"complete": True, "seconds": 1., "timings": {"inference": .6}})
            analysis = "ct"
        image = sitk.ReadImage(str(image_path))
        record = {"id": "sample", "analysis": analysis, "name": "sample", "input": str(image_path),
                  "metadata": {"size": image.GetSize(), "spacing": image.GetSpacing()}}
        message = {"id": "result", "record": record, "result": str(result), "createdAt": "2026-10-04T00:00:00Z", "deferMesh": True}
        protected = {p: worker.digest(p) for p in result.rglob("*") if p.is_file()}
        make_mesh = worker.make_mesh
        def forbidden(*_args): raise AssertionError("Early publication invoked meshing")
        worker.make_mesh = forbidden
        start = time.monotonic()
        early = worker.finalize(message, engine, {})
        ready_seconds = time.monotonic() - start
        assert early["mesh"] is None and early["summary"]["meshState"] == "pending"
        rows = copy.deepcopy(early["summary"]["rows"])
        before = worker.preview({"record": record, "mask": early["mask"], "rows": rows, "view": "axial"})
        assert before["image"].startswith("data:image/png;base64,")
        again = worker.finalize(message, engine, {})
        assert again["summary"]["rows"] == rows, "Pending mesh must not invalidate cached laterality"
        worker.make_mesh = make_mesh
        finished = worker.finish_mesh(copy.deepcopy(early))
        assert finished["summary"]["meshBytes"] > 0 and Path(finished["mesh"]).is_file()
        assert finished["summary"]["rows"] == rows
        assert early["summary"]["meshState"] == "pending"
        after = worker.preview({"record": record, "mask": finished["mask"], "rows": rows, "view": "axial"})
        assert before["image"] == after["image"]
        worker.make_mesh = forbidden
        cached = worker.finalize(message, engine, {})
        assert cached["summary"]["meshState"] == "ready"
        assert worker.finish_mesh(copy.deepcopy(cached))["summary"]["meshBytes"] == finished["summary"]["meshBytes"]
        assert all(worker.digest(p) == digest for p, digest in protected.items()), "Original results changed"
        report = {"sample": args.sample, "metrics_overlay_seconds": ready_seconds,
                  "mesh_seconds": finished["summary"]["timings"]["mesh"], "mesh_bytes": finished["summary"]["meshBytes"],
                  "rows": len(rows), "raw_unchanged": True, "overlay_unchanged": True}
        output = ROOT / "outputs/early-results-check"
        output.mkdir(parents=True, exist_ok=True)
        worker.write_json(output / ("sample.json" if args.sample else "synthetic.json"), report)
        print(json.dumps(report))
    print("PASS: early metrics/Overlay, deferred mesh, cache reuse, native parity, exclusive timing")

if __name__ == "__main__": main()

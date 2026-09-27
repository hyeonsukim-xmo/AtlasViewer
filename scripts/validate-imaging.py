"""Geometry/measurement/privacy-boundary checks; optional actual model replay report."""
import argparse
import base64
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
import uuid

import numpy as np
import SimpleITK as sitk
import nrrd
import nibabel as nib
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", action="store_true")
    args = parser.parse_args()
    engine = ROOT / "work/modality-integration"
    worker = module("imaging_worker", ROOT / "desktop/imaging-worker.py")
    runner = module("model_runner", ROOT / "desktop/model-runner.py")
    sys.path.insert(0, str(engine / "packages/EXMO_CT/src"))
    from thigh_muscle_seg_ct.core.artifacts import identifier
    # Real import UUIDs can start with digits or contain a date-like digit run.
    ids = ["2f58176a1fc24e848116d39f65316815", "0" * 32, "a12345678" + "f" * 23, "EXMO_CASE_001"]
    mapped = [identifier(runner.ct_case_id(value)) for value in ids]
    assert len(set(mapped)) == len(ids) and mapped == [runner.ct_case_id(value) for value in ids]
    output = ROOT / "outputs/imaging-check"
    output.mkdir(exist_ok=True, parents=True)
    report = {"geometry": [], "replays": {}}
    with tempfile.TemporaryDirectory(prefix="exmo-geometry-") as temp:
        root = Path(temp)
        # Asymmetric phantom: physical values reveal a left/right or superior flip.
        z, y, x = np.indices((9, 11, 13))
        phantom = sitk.GetImageFromArray((x + y * 100 + z * 10000).astype(np.float32))
        phantom.SetSpacing((1.5, 2.0, 3.0)); phantom.SetOrigin((-13., 21., -45.))
        for angle in (0, .27):
            c, s = np.cos(angle), np.sin(angle)
            phantom.SetDirection((c, -s, 0., s, c, 0., 0., 0., 1.))
            for view in ("axial", "coronal", "sagittal"):
                plane, index, count, sides = worker.plane(phantom, view, None)
                assert count > 1 and 0 <= index < count and len(sides) == 4
                array = sitk.GetArrayFromImage(sitk.Resample(phantom, plane, sitk.Transform(), sitk.sitkLinear, -1))[0]
                assert array.max() > 0 and np.isfinite(array).all()
                # The same reference produces exact overlay voxel alignment.
                labels = sitk.Cast(phantom > 50000, sitk.sitkUInt8)
                overlay = sitk.GetArrayFromImage(sitk.Resample(labels, plane, sitk.Transform(), sitk.sitkNearestNeighbor, 0))[0]
                assert array.shape == overlay.shape
                if angle == 0 and view == "coronal": assert array[0].mean() > array[-1].mean()
                if angle == 0 and view == "axial": assert array[:, -1].mean() > array[:, 0].mean()
                report["geometry"].append({"angle": angle, "view": view, "slices": count})
                # Optimized compositing must preserve every displayed pixel, geometry and class color.
                scan_path, mask_path = root / "preview.nrrd", root / "labels.nrrd"
                sitk.WriteImage(phantom, str(scan_path)); sitk.WriteImage(labels, str(mask_path))
                worker.clear_image_cache()
                record = {"input": str(scan_path), "analysis": "mri", "metadata": {}}
                # Outside value matches MRI's reslice (zero), including oblique padding.
                native = sitk.GetArrayFromImage(sitk.Resample(phantom, plane, sitk.Transform(), sitk.sitkLinear, 0))[0]
                lo, hi = np.percentile(native, [.5, 99.5])
                gray = (np.clip((native.astype(np.float32) - lo) / max(hi - lo, 1e-5), 0, 1) * 255).astype(np.uint8)
                for alpha in (0, .35, 1):
                    message = {"record": record, "mask": str(mask_path), "rows": [{"label": 1, "color": "#34B6ED"}], "view": view, "opacity": alpha}
                    encoded = worker.preview(message)["image"].split(",", 1)[1]
                    actual = np.array(Image.open(io.BytesIO(base64.b64decode(encoded))))
                    expected = np.repeat(gray[:, :, None], 3, axis=2).astype(np.float32)
                    region = overlay == 1
                    expected[region] = expected[region] * (1 - alpha) + np.array([52, 182, 237]) * alpha
                    assert np.array_equal(actual, expected.astype(np.uint8)), "Overlay optimization changed pixels"
                selected_none = worker.preview({**message, "classIds": []})["image"].split(",", 1)[1]
                assert np.array_equal(np.array(Image.open(io.BytesIO(base64.b64decode(selected_none)))), np.repeat(gray[:, :, None], 3, axis=2))
        # Disjoint classes must compose together, independently of label order.
        labels = sitk.GetImageFromArray(np.where(z > 3, 1, 2).astype(np.uint8))
        labels.CopyInformation(phantom)
        sitk.WriteImage(labels, str(mask_path)); worker.clear_image_cache()
        message = {"record": record, "mask": str(mask_path), "rows": [{"label": 1, "color": "#34B6ED"}, {"label": 2, "color": "#F14D9B"}], "view": "coronal", "opacity": .45}
        def pixels(selection):
            encoded = worker.preview({**message, "classIds": selection})["image"].split(",", 1)[1]
            return np.array(Image.open(io.BytesIO(base64.b64decode(encoded))))
        base, one, two, both = [pixels(ids) for ids in ([], [1], [2], [1, 2])]
        assert np.array_equal(both, pixels(None)), "All and multi-class overlay differ"
        assert not np.array_equal(one, both) and not np.array_equal(two, both)
        composite = base.copy()
        composite[np.any(one != base, axis=2)] = one[np.any(one != base, axis=2)]
        composite[np.any(two != base, axis=2)] = two[np.any(two != base, axis=2)]
        assert np.array_equal(both, composite), "Multi-class overlay lost a selected class"
        # Laterality is patient-space/component based, including an off-centre FOV and arbitrary origin.
        anatomy = np.zeros((28, 44, 100), dtype=np.uint8)
        anatomy[2:26, 20:27, 10:17] = 9
        anatomy[2:26, 20:27, 56:63] = 9
        anatomy[4:23, 3:12, 5:23] = 2
        anatomy[4:23, 3:12, 54:67] = 2
        anatomy[10:16, 33:39, 12:62] = 3  # One fused component crosses the anatomical midline.
        native = sitk.GetImageFromArray(anatomy); native.SetSpacing((2., 2., 3.)); native.SetOrigin((370., -110., 1200.))
        side_rows = [{"id": name, "label": cid, "count": int((anatomy == cid).sum()), "color": color, "group": "All", "name": name}
                     for cid, name, color in ((9, "femoral", "#ABCDEF"), (2, "rectus_femoris", "#34B6ED"), (3, "iliac", "#F14D9B"))]
        field = np.broadcast_to(np.where(np.arange(100) > 40, -80., 50.), anatomy.shape).astype(np.float32).copy()
        hu = sitk.GetImageFromArray(field); hu.CopyInformation(native)
        entropy = sitk.GetImageFromArray(np.where(field < 0, .4, .2).astype(np.float32)); entropy.CopyInformation(native)
        reference = worker.laterality_reference(native, 9)
        assert reference["status"] == "estimated"
        separated, side_metrics = worker.split_laterality(native, side_rows, reference, hu, entropy)
        expected_sides = sitk.GetArrayFromImage(separated)
        muscle = side_metrics["rectus_femoris"]
        assert muscle["left"]["count"] == int((anatomy[:, :, 40:] == 2).sum())
        assert muscle["right"]["count"] == int((anatomy[:, :, :40] == 2).sum())
        assert muscle["left"]["fat"] == 100 and muscle["right"]["fat"] == 0
        assert np.isclose(muscle["left"]["entropy"], .4) and np.isclose(muscle["right"]["entropy"], .2)
        assert np.isclose(muscle["differencePercent"], abs(13 - 18) / ((13 + 18) / 2) * 100)
        assert side_metrics["iliac"]["unassigned"]["count"] == int((anatomy == 3).sum())
        assert side_metrics["iliac"]["differencePercent"] is None, "Fused anatomy must not be silently cut into invented L/R"
        for transform in (lambda im: sitk.Flip(im, [True, False, True]), lambda im: sitk.PermuteAxes(im, [2, 0, 1])):
            changed = transform(native)
            split, metrics = worker.split_laterality(changed, side_rows, worker.laterality_reference(changed, 9))
            restored = sitk.GetArrayFromImage(sitk.Resample(split, native, sitk.Transform(), sitk.sitkNearestNeighbor, 0))
            assert np.array_equal(restored, expected_sides), "Axis order/storage flips must not change patient laterality"
        angled = sitk.Image(native); c, s = np.cos(.27), np.sin(.27)
        angled.SetDirection((c, -s, 0., s, c, 0., 0., 0., 1.))
        split, _ = worker.split_laterality(angled, side_rows, worker.laterality_reference(angled, 9))
        assert np.array_equal(sitk.GetArrayFromImage(split), expected_sides), "Oblique acquisition changed anatomical side"
        single = anatomy.copy(); single[(single == 9) & (np.indices(single.shape)[2] > 40)] = 0
        unilateral = sitk.GetImageFromArray(single); unilateral.CopyInformation(native)
        unavailable = worker.laterality_reference(unilateral, 9)
        assert unavailable["status"] == "unavailable", "One-sided scan cannot supply a bilateral anchor"
        unilateral_rows = [{**row, "count": int((single == row['label']).sum())} for row in side_rows]
        unknown, unknown_metrics = worker.split_laterality(unilateral, unilateral_rows, unavailable)
        assert np.array_equal(sitk.GetArrayFromImage(unknown), single * 3)
        assert all(row["differencePercent"] is None for row in unknown_metrics.values())
        for row in side_rows:
            assert sum(side_metrics[row["id"]][side]["count"] for side in worker.SIDE_CODES) == row["count"]
        # Each side composes at the native physical position; the union is exactly the original overlay.
        side_input, original_mask, side_mask = [root / name for name in ("side-input.nrrd", "side-original.nrrd", "side-map.nrrd")]
        sitk.WriteImage(hu, str(side_input)); sitk.WriteImage(native, str(original_mask)); sitk.WriteImage(separated, str(side_mask))
        side_message = {"record": {"input": str(side_input), "analysis": "ct", "metadata": {}}, "mask": str(original_mask), "sideMask": str(side_mask), "rows": side_rows, "view": "axial", "index": 14, "opacity": .45}
        def side_pixels(side, selection=None):
            result = worker.preview({**side_message, "side": side, "classIds": selection})
            return np.array(Image.open(io.BytesIO(base64.b64decode(result["image"].split(",", 1)[1]))))
        blank, combined = side_pixels("all", []), side_pixels("all")
        union = blank.copy()
        for side in worker.SIDE_CODES:
            overlay = side_pixels(side)
            region = np.any(overlay != blank, axis=2); union[region] = overlay[region]
        assert np.array_equal(union, combined), "L/R/unassigned overlay union must equal the unchanged native mask"
        assert not np.array_equal(side_pixels("left"), side_pixels("right"))
        report["laterality"] = "native voxel conservation; translated/off-centre, flipped, permuted and oblique geometry; one-sided/fused regions withheld; per-side HU/entropy; pixel-exact overlay union"
        # Strong PP uses the delivered physical-volume recipe and keeps raw immutable.
        case = root / "pp-check"; (case / "raw").mkdir(parents=True)
        array = np.zeros((12, 24, 30), dtype=np.uint8)
        for cid, depth in ((1, 2), (24, 7)):
            for start, count in ((1, 10), (5, 8), (9, 4), (13, 3)):
                array[depth, start, :count] = cid
        mask = sitk.GetImageFromArray(array); mask.SetSpacing((5., 5., 5.)); mask.SetOrigin((-10., 30., -50.))
        sitk.WriteImage(mask, str(case / "raw/mask.nrrd"))
        entropy = sitk.GetImageFromArray(np.linspace(0, 1, array.size, dtype=np.float32).reshape(array.shape))
        entropy.CopyInformation(mask); sitk.WriteImage(entropy, str(case / "entropy.nrrd"))
        before = worker.digest(case / "raw/mask.nrrd")
        candidate = worker.strong_candidate(case, engine)
        output_mask = sitk.ReadImage(str(candidate / "mask.nrrd")); actual = sitk.GetArrayFromImage(output_mask)
        assert worker.digest(case / "raw/mask.nrrd") == before
        assert output_mask.GetSpacing() == mask.GetSpacing() and output_mask.GetOrigin() == mask.GetOrigin()
        assert output_mask.GetDirection() == mask.GetDirection() and output_mask.GetSize() == mask.GetSize()
        assert np.count_nonzero(actual == 1) == 18, "Muscle must retain the two largest components"
        assert np.count_nonzero(actual == 24) == 22, "Trunk must retain three >=500 mm3 components"
        assert np.all((actual == 0) | (actual == array)), "PP must not invent or reassign labels"
        metrics = worker.read_json(candidate / "metrics.json")
        assert metrics["postprocessing"]["changed_voxels"] == 10
        for row in metrics["classes"]:
            region = actual == row["label_id"]
            assert row["voxel_count"] == int(region.sum())
            assert np.isclose(row["volume_ml"], region.sum() * 125 / 1000)
            if region.any(): assert np.isclose(row["mean_entropy"], sitk.GetArrayViewFromImage(entropy)[region].mean())
        assert worker.strong_candidate(case, engine) == candidate, "Unchanged candidate should be reused"
        report["postprocessing"] = "raw immutable; exact mm3 threshold; muscle top2; trunk exempt; native geometry, volume and entropy preserved"
        limit = worker.IMAGE_CACHE_LIMIT
        try:
            worker.clear_image_cache(); worker.IMAGE_CACHE_LIMIT = 16000
            image = worker.cached_image(scan_path)
            assert worker.cached_image(scan_path) is image, "Warm previews must reuse their image"
            for i in range(8):
                candidate = root / f"cache-{i}.nrrd"; sitk.WriteImage(phantom, str(candidate))
                worker.cached_image(candidate)
                assert worker.image_cache_bytes <= worker.IMAGE_CACHE_LIMIT and len(worker.image_cache) <= 6
            assert str(scan_path) not in worker.image_cache, "Least-recent image must be evicted"
        finally:
            worker.IMAGE_CACHE_LIMIT = limit; worker.clear_image_cache()
        report["preview"] = "pixel-exact color/opacity/selection in 3 physical views; bounded image cache"
        nrrd.write(str(root / "valid.nrrd"), np.arange(4 * 5 * 6, dtype=np.float32).reshape(4, 5, 6), {"space": "left-posterior-superior", "space directions": np.diag([1, 2, 3]), "space origin": [0, 0, 0]})
        assert worker.load_image(root / "valid.nrrd").GetSpacing() == (1., 2., 3.)
        bad = nib.Nifti1Image(np.ones((4, 5, 6)), np.eye(4)); nib.save(bad, root / "no-mm.nii")
        try: worker.load_image(root / "no-mm.nii")
        except worker.InputError: pass
        else: raise AssertionError("Missing mm unit accepted")
        (root / "detached.nrrd").write_text("NRRD0005\ntype: float\ndimension: 3\nsizes: 4 5 6\nencoding: raw\ndata file: outside.raw\n\n")
        try: worker.load_image(root / "detached.nrrd")
        except worker.InputError: pass
        else: raise AssertionError("Detached NRRD accepted")
        sys.path.insert(0, str(engine / "packages/EXMO_CT/src"))
        from thigh_muscle_seg_ct.core import atomic
        runner.windows_transactions(atomic)
        with atomic.directory_transaction(root / "published") as stage:
            atomic.atomic_write_json(stage / "value.json", {"ok": True})
        try:
            with atomic.directory_transaction(root / "published") as stage:
                atomic.atomic_write_json(stage / "value.json", {"ok": False})
        except Exception: pass
        else: raise AssertionError("Existing result overwritten")
        assert json.loads((root / "published/value.json").read_text())["ok"]
        from types import SimpleNamespace
        runtime = runner.load_module("ct_inverse_check", engine / "packages/EXMO_CT/run.py")
        rng = np.random.default_rng(73)
        probabilities = rng.random((33, 7, 9, 11), dtype=np.float32)
        probabilities /= probabilities.sum(axis=0, keepdims=True)
        grid = runtime.geometry_from_affine((11, 9, 7), np.diag([2., 2., 2., 1.]))
        affine = np.diag([2., 2., 2., 1.]); affine[:3, 3] = .5
        native_grid = runtime.geometry_from_affine((9, 7, 5), affine)
        native = SimpleNamespace(data_zyx=np.zeros((5, 7, 9), dtype=np.float32), geometry=native_grid)
        probability = runtime.ProbabilityVolume(probabilities, grid)
        expected, _ = runtime.inverse(probability, native)
        runner.emit = lambda *args, **kwargs: None
        actual, _ = runner.ct_inverse(runtime, root)(probability, native)
        assert np.array_equal(actual.data_zyx, expected.data_zyx), "Disk-backed inverse changed class argmax"
        report["ct_inverse"] = "same probabilities -> voxel-exact physical inverse and renormalized argmax"
        from pydicom.dataset import FileDataset, FileMetaDataset
        from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid
        dicoms = []
        for case in range(2):
            study = generate_uid()
            for series in range(2):
                uid, frame = generate_uid(), generate_uid()
                for slice_id in (3, 1, 0, 2):
                    meta = FileMetaDataset(); meta.TransferSyntaxUID = ExplicitVRLittleEndian
                    meta.MediaStorageSOPClassUID = CTImageStorage; meta.MediaStorageSOPInstanceUID = generate_uid()
                    ds = FileDataset("", {}, file_meta=meta, preamble=b"\0" * 128)
                    ds.SOPClassUID = CTImageStorage; ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
                    ds.StudyInstanceUID = study; ds.SeriesInstanceUID = uid; ds.FrameOfReferenceUID = frame
                    ds.Modality = "CT"; ds.SeriesDescription = "Same description, different series"
                    ds.PatientName = "SYNTHETIC"; ds.Rows = 8; ds.Columns = 7
                    ds.SamplesPerPixel = 1; ds.PhotometricInterpretation = "MONOCHROME2"
                    ds.BitsAllocated = 16; ds.BitsStored = 16; ds.HighBit = 15; ds.PixelRepresentation = 0
                    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]; ds.ImagePositionPatient = [0, 0, slice_id * 3]
                    ds.PixelSpacing = [2, 1.5]; ds.RescaleSlope = 2; ds.RescaleIntercept = -1024; ds.RescaleType = "HU"
                    ds.PixelData = np.full((8, 7), 100 + slice_id, dtype="<u2").tobytes()
                    file = root / f"{case}-{series}-{slice_id}.dcm"; ds.save_as(file, enforce_file_format=True); dicoms.append(file)
        groups = worker.dicom_series(dicoms, "ct")
        assert len(groups) == 4 and all(len(group) == 4 for group in groups)
        volume, _ = worker.read_dicom(groups[0], "ct")
        assert volume.GetSpacing() == (1.5, 2., 3.)
        assert np.array_equal(sitk.GetArrayFromImage(volume)[:, 0, 0], [-824, -822, -820, -818]), "DICOM sorting/rescale mismatch"
        for invalid in (groups[0] + [groups[0][0]], [file for file in groups[0] if not file.stem.endswith("-1")]):
            try: worker.read_dicom(invalid, "ct")
            except worker.InputError: pass
            else: raise AssertionError("Duplicate/missing slice accepted")
        report["dicom"] = "4 distinct Study/Series groups; shuffled ordering, rescale once, duplicate/gap rejection"
    if args.results:
        sys.path.insert(0, str(engine / "packages/EXMO_XRAY/classification"))
        classifier = module("private_classifier", ROOT / "desktop/classifier-worker.py")
        classification = engine / "packages/EXMO_XRAY/classification"
        classifier.engine.DEFAULT_DICOM_CACHE = classification / "models/dicom/training_features_4class_dicom_260711_corrected.npz"
        classifier.engine.DEFAULT_NRRD_CACHE = classification / "models/nrrd/training_features_4class_nrrd_260711.npz"
        classifier.pipeline = classifier.ViewClassificationPipeline(min_confidence=.4)
        palette = {r["id"]: r for r in json.loads((ROOT / "dist-desktop/imaging-palette.json").read_text())}
        storage = output / "userdata/imaging"
        # Rebuild only this generated test fixture, never application userData or source deliveries.
        assert storage.resolve().is_relative_to((ROOT / "outputs/imaging-check").resolve())
        if storage.exists(): shutil.rmtree(storage)
        run_root = storage / "runs"; run_root.mkdir(exist_ok=True, parents=True)
        records, summaries = [], []
        tests = [
            ("ct", "packages/EXMO_CT/samples/EXMO_CASE_001/input_ct.nii.gz", "ct-run-01/EXMO_CASE_001", "packages/EXMO_CT/results/EXMO_CASE_001/mask.nii.gz", "mask.nii.gz"),
            ("mri", "packages/EXMO_MRI/samples/sample_01/W.nrrd", "mri-run-01/sample_01", "packages/EXMO_MRI/samples/sample_01/raw/mask.nrrd", "raw/mask.nrrd"),
            ("mri", "packages/EXMO_MRI/samples/sample_02/W.nrrd", "mri-sample_02/sample_02", "packages/EXMO_MRI/samples/sample_02/raw/mask.nrrd", "raw/mask.nrrd"),
            ("mri", "packages/EXMO_MRI/samples/sample_03/W.nrrd", "mri-sample_03/sample_03", "packages/EXMO_MRI/samples/sample_03/raw/mask.nrrd", "raw/mask.nrrd"),
            ("xray", "packages/EXMO_XRAY/samples/AP/AP_01/input.nrrd", "ap-run-01", "packages/EXMO_XRAY/outputs/reference/AP/AP_01/mask.seg.nrrd", "mask.seg.nrrd"),
            ("xray", "packages/EXMO_XRAY/samples/LAT_LT/LAT_LT_01/input.nrrd", "lat-lt-run-01", "packages/EXMO_XRAY/outputs/reference/LAT_LT/LAT_LT_01/mask.seg.nrrd", "mask.nrrd"),
            ("xray", "packages/EXMO_XRAY/samples/LAT_RT/LAT_RT_01/input.nrrd", "lat-rt-run-01", "packages/EXMO_XRAY/outputs/reference/LAT_RT/LAT_RT_01/mask.seg.nrrd", "mask.nrrd"),
        ]
        for analysis, source, run_name, reference, mask_file in tests:
            source, result = engine / source, engine / "validation" / run_name
            if not (result / "desktop-complete.json").exists():
                report["replays"][run_name] = {"status": "not_complete"}; continue
            prepared = storage / "imports" / uuid.uuid4().hex
            rows = worker.inspect({"analysis": analysis, "paths": [str(source)], "names": {str(source): source.parent.name}, "destination": str(prepared)}, engine, classifier)
            assert len(rows) == 1 and rows[0]["ready"], rows
            record = rows[0]; records.append(record)
            ident = str(uuid.uuid4()); destination = run_root / ident / "output"
            shutil.copytree(result, destination)
            publication = worker.finalize({"id": ident, "record": record, "result": str(destination), "createdAt": "2026-09-27T00:00:00Z"}, engine, palette)
            worker.write_json(destination.parent / "published.json", publication)
            summaries.append(publication["summary"])
            native = sitk.GetArrayFromImage(sitk.ReadImage(str(destination / mask_file)))
            expected = sitk.GetArrayFromImage(sitk.ReadImage(str(engine / reference)))
            assert native.shape == expected.shape
            report["replays"][run_name] = {"different_voxels": int(np.count_nonzero(native != expected)), "fraction": float(np.mean(native != expected)), "total_voxels": int(native.size), "classes": len(publication["summary"]["rows"]), "model_seconds": publication["summary"]["seconds"]}
            image = worker.preview({"record": record, "mask": publication["mask"], "rows": publication["summary"]["rows"], "view": "coronal" if analysis != "xray" else "axial"})
            (output / (analysis + "-" + source.parent.name + "-overlay.png")).write_bytes(base64.b64decode(image["image"].split(",", 1)[1]))
        worker.write_json(storage / "library.json", records)
        worker.write_json(output / "results.json", summaries)
    worker.write_json(output / ("report.json" if args.results else "geometry-report.json"), report)
    print(json.dumps(report))
    print("PASS: physical views, input boundaries, no-overwrite publication, native metrics and overlays")


if __name__ == "__main__": main()

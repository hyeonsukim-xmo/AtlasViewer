"""Private, one-job process. Vendor weights and numerical recipes stay in their bundles."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import importlib.util
import itertools
import json
import os
from pathlib import Path
import sys
import time

os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
sys.dont_write_bytecode = True


def emit(stage, **values):
    print(json.dumps({"exmo": True, "stage": stage, **values}), flush=True)


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def windows_transactions(module):
    """Keep vendor file fsyncs; Windows publication is write-through and never replaces."""
    if os.name != "nt":
        return
    move = ctypes.WinDLL("kernel32", use_last_error=True).MoveFileExW
    move.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32)
    move.restype = ctypes.c_int

    def publish(source, destination):
        # No MOVEFILE_REPLACE_EXISTING: a conflicting result must never be overwritten.
        if not move(str(source), str(destination), 0x8):
            error = ctypes.get_last_error()
            if error in (80, 183):
                raise module.ConflictError("Destination exists; overwrite is prohibited")
            raise ctypes.WinError(error)

    module._rename_directory_noreplace = publish
    # POSIX directory handles cannot be fsynced on Windows. Files are fsynced by
    # the original writers and directory publication uses MOVEFILE_WRITE_THROUGH.
    module._fsync_directory = lambda _path: None


def windows_nrrd_reader(module):
    """Hold a read-only, no-replace Windows file handle through hash and vendor decode."""
    if os.name != "nt":
        return
    from contextlib import contextmanager
    import hashlib
    import msvcrt
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = (ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p)
    create.restype = ctypes.c_void_p
    close = kernel.CloseHandle
    close.argtypes = (ctypes.c_void_p,)
    info = kernel.GetFileInformationByHandleEx
    info.argtypes = (ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32)

    @contextmanager
    def snapshot(source):
        path = Path(os.path.abspath(source))
        handles = []
        try:
            # Anchor each parent without FILE_SHARE_DELETE; reject reparse points.
            for entry in [*reversed(path.parents), path]:
                is_file = entry == path
                handle = create(str(entry), 0x80000000, 1 if is_file else 3, None, 3, 0x02200000, None)
                if handle == ctypes.c_void_p(-1).value:
                    raise ctypes.WinError(ctypes.get_last_error())
                handles.append(handle)
                attributes = (ctypes.c_uint32 * 2)()
                if not info(handle, 9, ctypes.byref(attributes), ctypes.sizeof(attributes)):
                    raise ctypes.WinError(ctypes.get_last_error())
                if attributes[0] & 0x400 or bool(attributes[0] & 0x10) == is_file:
                    raise module.ImageIOContractError("NRRD path must not contain reparse points")
            descriptor = msvcrt.open_osfhandle(handles.pop(), os.O_RDONLY | os.O_BINARY)
            with os.fdopen(descriptor, "rb") as stream:
                size = os.fstat(stream.fileno()).st_size
                if size > 2 * 1024 ** 3:
                    raise module.ImageIOContractError("NRRD exceeds desktop byte limit")
                sha = hashlib.file_digest(stream, "sha256").hexdigest()
                yield path, module.ArtifactRecord(path=str(path), sha256=sha, size_bytes=size)
                stream.seek(0)
                if hashlib.file_digest(stream, "sha256").hexdigest() != sha:
                    raise module.ImageIOContractError("NRRD changed while decoding")
        finally:
            for handle in reversed(handles):
                close(handle)
    module._secure_nrrd_snapshot = snapshot


def ct_inverse(runtime, scratch):
    """Same 33-class physical inverse/float32 renormalization, bounded resident memory."""
    import numpy as np

    def inverse(probability, native):
        probability.require_ct_thigh_ontology()
        corners = np.array(list(itertools.product(*[(0, n - 1) for n in native.geometry.shape_xyz])))
        indices = probability.geometry.lps_to_continuous_index_xyz(native.geometry.index_center_xyz_to_lps(corners))
        runtime.require(np.all(indices >= -.5 - 1e-5) and np.all(indices < np.asarray(probability.geometry.shape_xyz) - .5 + 1e-5), "Model grid does not cover native voxel centers")
        parameters = runtime.anti_alias_parameters(probability.geometry, native.geometry)
        mmap_path = scratch / "native-probabilities.tmp"
        restored = np.memmap(mmap_path, mode="w+", shape=(33, *native.data_zyx.shape), dtype=np.float32)
        try:
            for cid in range(33):
                outside = float(cid == 0)
                channel = runtime.gaussian_prefilter_zyx(probability.data_czyx[cid], parameters, outside_value=outside)
                restored[cid] = runtime.resample_array_zyx(channel, probability.geometry, native.geometry, interpolation="linear", outside_value=outside)
                emit("native_inverse", current=cid + 1, total=33)
            labels = np.empty(native.data_zyx.shape, dtype=np.uint8)
            error = 0.0
            # Normalize all channels together, with original float64 sums and float32 storage.
            for z in range(labels.shape[0]):
                slab = restored[:, z]
                runtime.require(np.isfinite(slab).all() and slab.min() >= -1e-5 and slab.max() <= 1 + 1e-5, "Invalid native probability range")
                np.clip(slab, 0, 1, out=slab)
                sums = slab.sum(axis=0, dtype=np.float64)
                error = max(error, float(np.max(np.abs(sums - 1))))
                runtime.require(np.all(sums > 0) and error <= 1e-4, "Invalid native probability simplex")
                slab /= sums[None]
                labels[z] = slab.argmax(axis=0).astype(np.uint8)
            del slab
        finally:
            restored._mmap.close()
            mmap_path.unlink(missing_ok=True)
        label = runtime.LabelVolume(labels, native.geometry, runtime.ONTOLOGY_ID)
        qc = {"status": "passed", "native_voxel_centers_covered": True, "probability_channels": 33,
              "simplex_max_error_before_renormalization": error, "anti_alias": parameters.to_dict(),
              "argmax_grid": "native", "interpolation": "linear_per_class", "outside_values": [1.] + [0.] * 32,
              "renormalized": True, "fallback": None, "storage": "disk_mapped_slice_renormalization"}
        return label, qc
    return inverse


def ct_case_id(value):
    # The vendor rejects leading digits and eight consecutive digits (date-like IDs).
    # Retain 128 bits of identity while leaving room for Windows transaction filenames.
    return "case_" + hashlib.sha256(value.encode("utf8")).hexdigest()[:32].translate(str.maketrans("0123456789", "ghijklmnop"))


def run_ct(root, job):
    import numpy as np
    import torch
    import SimpleITK as sitk
    runtime = load_module("exmo_ct_vendor", root / "run.py")
    from thigh_muscle_seg_ct.core import atomic
    from thigh_muscle_seg_ct.core.artifacts import identifier
    windows_transactions(atomic)
    cfg = read(root / "configs/inference.json")
    torch.set_num_threads(4)
    sitk.ProcessObject.SetGlobalDefaultNumberOfThreads(4)
    torch.manual_seed(cfg["seed"])
    np.random.seed(cfg["seed"])
    torch.use_deterministic_algorithms(True)
    source = Path(job["input"])
    case_id = identifier(ct_case_id(job["id"]))
    case = {"case_id": case_id, "input": str(source), "input_sha256": runtime.sha256_file(source)}
    for name in ("hu_evidence", "source_proof"):
        case[name + "_sha256"] = runtime.sha256_file(source.parent / (name + ".json"))
    device = "cpu"  # Supplied, verified CT recipe is FP32 CPU; no implicit CUDA/AMP conversion.
    emit("model_loading", device=device)
    model, model_hash = runtime.model_for(cfg, device)
    output = Path(job["output"])
    output.mkdir(parents=True, exist_ok=False)
    runtime.inverse = ct_inverse(runtime, output)
    runtime.log = lambda event, **value: emit(event, **value)
    runtime.run_case(case, cfg, model, model_hash, device, output, 4)
    return output / case_id


def run_mri(root, job):
    import torch
    runtime = load_module("exmo_mri_vendor", root / "run_inference.py")
    from thigh_muscle_seg.core import atomic
    windows_transactions(atomic)
    if os.name == "nt":
        from types import SimpleNamespace
        from thigh_muscle_seg.core import structured_input
        # POSIX omits O_BINARY. On Windows text-mode os.read translates CRLF/Ctrl-Z,
        # so hashed bytes and size no longer match. Keep every original integrity check.
        structured_input.os = SimpleNamespace(**vars(os))
        structured_input.os.O_RDONLY |= os.O_BINARY
        from thigh_muscle_seg.data import image_io
        windows_nrrd_reader(image_io)
        import inspect
        from thigh_muscle_seg.integrations import slicer_export
        source = inspect.getsource(slicer_export.export_slicer_segmentation)
        directory_flush = "        directory_fd = os.open(parent, os.O_RDONLY)\n        try:\n            os.fsync(directory_fd)\n        finally:\n            os.close(directory_fd)"
        if source.count('temporary.open("rb")') != 1 or source.count(directory_flush) != 1:
            raise RuntimeError("Unexpected MRI export implementation; Windows adaptation blocked")
        # Windows _commit needs a writable fd. Adapt only the temporary-output open
        # and POSIX directory fsync; header creation and readback checks are unchanged.
        source = source.replace('temporary.open("rb")', 'temporary.open("r+b")').replace(directory_flush, "        _desktop_fsync_directory(parent)")
        slicer_export._desktop_fsync_directory = atomic._fsync_directory
        exec(compile(source, slicer_export.__file__, "exec"), slicer_export.__dict__)
        runtime.export_slicer_segmentation = slicer_export.export_slicer_segmentation
    torch.set_num_threads(4)
    device = job.get("device", "cuda:0")
    emit("inference_start", device=device)
    # Keep native full6 FP32, both TTA passes, raw + PP500. No hidden fallback.
    runtime.run([(job["id"], Path(job["input"]))], Path(job["output"]), device)
    return Path(job["output"]) / job["id"]


def run_ap(root, job):
    import torch
    sys.path.insert(0, str(root / "code"))
    import InferenceLOWEX_slicer_nrrd as legacy
    torch.set_num_threads(4)
    names, size = legacy.get_class_names("AP"), legacy.get_target_size("AP")
    checkpoint = root / "models/AP/model.pth"
    device = torch.device(job.get("device", "cuda:0"))
    emit("model_loading", device=str(device))
    model = legacy.build_model("vnet", len(names), size, "AP").to(device)
    model, _ = legacy.load_checkpoint_to_model(model, checkpoint, device)
    model.eval()
    output = Path(job["output"])
    output.mkdir(parents=True, exist_ok=False)
    emit("inference_start")
    result = legacy.run_inference_case(Path(job["input"]), "AP", output, model, checkpoint, "vnet", names, len(names), size, device, .55, True, output_prefix="case")
    import shutil
    shutil.copyfile(result["mask_path"], output / "mask.seg.nrrd")
    metrics = read(result["json_path"])
    metrics.update(volume_cm3=None, volume_status="unsupported_2d_projection", tta="none")
    (output / "metrics.json").write_text(json.dumps(metrics), encoding="utf-8")
    return output


def run_lat(root, job):
    import numpy as np
    import nibabel as nib
    import nrrd
    import SimpleITK as sitk
    import torch
    from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor
    from nnunetv2.imageio.simpleitk_reader_writer import SimpleITKIO
    sys.path.insert(0, str(root / "code"))
    from reliability_lab.metrics import component_qc
    route = job["route"]
    if route not in ("LAT_LT", "LAT_RT"):
        raise ValueError("Unsupported lateral view")
    torch.set_num_threads(4)
    device = torch.device(job.get("device", "cuda:0"))
    emit("model_loading", device=str(device))
    # ponytail: one GPU job; retain five folds, mirroring and the original patch size.
    predictor = nnUNetPredictor(tile_step_size=.5, use_gaussian=True, use_mirroring=True,
        perform_everything_on_device=False, device=device, verbose=False, verbose_preprocessing=False, allow_tqdm=False)
    predictor.initialize_from_trained_model_folder(str(root / "models" / route), (0, 1, 2, 3, 4), checkpoint_name="checkpoint_final.pth")
    output = Path(job["output"])
    output.mkdir(parents=True, exist_ok=False)
    image = sitk.ReadImage(str(job["input"]))
    if image.GetDimension() != 3 or image.GetSize()[2] != 1:
        raise ValueError("Lateral inference requires a single projection")
    xyz = sitk.GetArrayFromImage(image).transpose(2, 1, 0).astype(np.float32, copy=False)
    affine = np.eye(4)
    affine[:3, :3] = np.array(image.GetDirection()).reshape(3, 3) @ np.diag(image.GetSpacing())
    affine[:3, 3] = image.GetOrigin()
    # Frozen legacy intermediate convention is deliberately NOT a registration affine.
    converted = output / "model_input.nii.gz"
    nifti = nib.Nifti1Image(xyz, affine)
    nifti.set_data_dtype(np.float32)
    nib.save(nifti, converted)
    data, properties = SimpleITKIO().read_images([str(converted)])
    emit("inference_start", folds=5, tta=True)
    mask = predictor.predict_single_npy_array(data, properties, None, None, False)
    labels = mask.transpose(2, 1, 0).astype(np.uint8)
    if labels.shape != xyz.shape:
        raise ValueError("Native shape mismatch")
    source_header = nrrd.read_header(job["input"])
    header = {k: v for k, v in source_header.items() if k in ("space", "space directions", "space origin", "space units", "kinds")}
    nrrd.write(str(output / "mask.nrrd"), labels, header, index_order="F")
    qc = {str(k): component_qc(mask[0] == k) for k in (1, 2, 3, 6, 7, 10, 11)}
    (output / "qc.json").write_text(json.dumps({"components": qc, "folds": [0, 1, 2, 3, 4], "test_time_mirroring": True,
        "accumulation": "cpu", "missing_active_class_ids": [k for k in (1, 2, 3, 6, 7, 10, 11) if not np.any(mask == k)],
        "unexpected_class_ids": [int(k) for k in np.unique(mask) if k not in (0, 1, 2, 3, 6, 7, 10, 11)]}), encoding="utf-8")
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-root", type=Path, required=True)
    parser.add_argument("--job", type=Path, required=True)
    args = parser.parse_args()
    job = read(args.job)
    start = time.monotonic()
    modality = job["analysis"]
    package = {"ct": "EXMO_CT", "mri": "EXMO_MRI", "xray": "EXMO_XRAY"}[modality]
    root = args.engine_root / "packages" / package
    handler = {"ct": run_ct, "mri": run_mri, "xray": run_ap if job.get("route") == "AP" else run_lat}[modality]
    result = handler(root, job)
    identity = {"schema": 1, "analysis": modality, "route": job.get("route"), "seconds": time.monotonic() - start,
                "adapter": "EXMO_WINDOWS_V1", "adapter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "complete": True}
    (result / "desktop-complete.json").write_text(json.dumps(identity), encoding="utf-8")
    emit("complete", result=str(result), **identity)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Private stderr is retained by main for local diagnostics; never forwarded to renderer.
        import traceback
        traceback.print_exc()
        emit("failed")
        sys.exit(1)

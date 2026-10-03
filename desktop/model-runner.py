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
import threading

os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
sys.dont_write_bytecode = True
_context = threading.local()
_emit_lock = threading.Lock()
_stdout = sys.stdout
_model_cache = {}


def emit(stage, **values):
    control = getattr(_context, "control", None)
    event = {"exmo": True, "stage": stage, "monotonic_seconds": time.monotonic(), **values}
    if control is not None:
        if stage in ("complete", "failed"):
            control.finished = True
        event["job_id"] = control.ident
    with _emit_lock:
        _stdout.write(json.dumps(event) + "\n")
        _stdout.flush()


def cached_model(key, paths, loader):
    """Reuse immutable weights inside one batch; file changes invalidate the cache."""
    if getattr(_context, "control", None) is None:
        return loader(), False
    signature = tuple((str(p), p.stat().st_size, p.stat().st_mtime_ns) for p in paths)
    cached = _model_cache.get(key)
    if cached and cached[0] == signature:
        emit("model_reused")
        return cached[1], True
    value = loader()
    _model_cache[key] = (signature, value)
    return value, False


def cpu_phase(job, torch):
    control = getattr(_context, "control", None)
    if control is not None and job.get("device", "cuda:0") != "cpu":
        control.cpu_phase(job, torch)


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


def ct_normalized_argmax(slab, sums):
    """Same float32 division and first-class tie rule without a 33-channel transpose."""
    import numpy as np
    best = (slab[0] / sums).astype(np.float32)
    labels = np.zeros(best.shape, dtype=np.uint8)
    for cid in range(1, slab.shape[0]):
        value = (slab[cid] / sums).astype(np.float32)
        greater = value > best
        np.copyto(best, value, where=greater)
        np.copyto(labels, np.uint8(cid), where=greater)
    return labels


def ct_inverse(runtime, scratch):
    """Same physical interpolation and normalized argmax, without a native CZYX file."""
    import numpy as np
    import SimpleITK as sitk

    def inverse(probability, native):
        probability.require_ct_thigh_ontology()
        corners = np.array(list(itertools.product(*[(0, n - 1) for n in native.geometry.shape_xyz])))
        indices = probability.geometry.lps_to_continuous_index_xyz(native.geometry.index_center_xyz_to_lps(corners))
        runtime.require(np.all(indices >= -.5 - 1e-5) and np.all(indices < np.asarray(probability.geometry.shape_xyz) - .5 + 1e-5), "Model grid does not cover native voxel centers")
        parameters = runtime.anti_alias_parameters(probability.geometry, native.geometry)
        # Copy each filtered MODEL-grid channel into ITK once, not once per output block.
        # Native probabilities exist only for one bounded block; never create a mmap.
        images = []
        source_geometry = probability.geometry
        for cid in range(33):
            channel = runtime.gaussian_prefilter_zyx(probability.data_czyx[cid], parameters, outside_value=float(cid == 0))
            runtime.require(channel.shape == tuple(reversed(source_geometry.shape_xyz)) and np.isfinite(channel).all(), "Invalid model probability channel")
            image = sitk.GetImageFromArray(channel)
            image.SetSpacing(tuple(source_geometry.spacing_xyz_mm))
            image.SetOrigin(tuple(source_geometry.origin_lps_mm))
            image.SetDirection(tuple(source_geometry.direction_array().ravel()))
            images.append(image)
            emit("native_prepare", current=cid + 1, total=33)
        del channel, image
        labels = np.empty(native.data_zyx.shape, dtype=np.uint8)
        error = 0.0
        plane = labels.shape[1] * labels.shape[2]
        # At most 256 MiB of probability payload, and at most 16 native slices.
        depth = max(1, min(16, (256 * 1024 ** 2) // (33 * plane * 4)))
        resampler = sitk.ResampleImageFilter()
        resampler.SetOutputSpacing(tuple(native.geometry.spacing_xyz_mm))
        resampler.SetOutputDirection(tuple(native.geometry.direction_array().ravel()))
        resampler.SetTransform(sitk.Transform(3, sitk.sitkIdentity))
        resampler.SetInterpolator(sitk.sitkLinear)
        resampler.SetOutputPixelType(sitk.sitkFloat32)
        for z in range(0, labels.shape[0], depth):
            end = min(z + depth, labels.shape[0])
            origin = native.geometry.index_center_xyz_to_lps(np.array([0., 0., float(z)]))
            resampler.SetOutputOrigin(tuple(float(value) for value in origin))
            resampler.SetSize((labels.shape[2], labels.shape[1], end - z))
            slab = np.empty((33, end - z, labels.shape[1], labels.shape[2]), dtype=np.float32)
            for cid, image in enumerate(images):
                resampler.SetDefaultPixelValue(float(cid == 0))
                restored = resampler.Execute(image)
                slab[cid] = sitk.GetArrayViewFromImage(restored)
                del restored
            runtime.require(np.isfinite(slab).all() and slab.min() >= -1e-5 and slab.max() <= 1 + 1e-5, "Invalid native probability range")
            np.clip(slab, 0, 1, out=slab)
            sums = slab.sum(axis=0, dtype=np.float64)
            error = max(error, float(np.max(np.abs(sums - 1))))
            runtime.require(np.all(sums > 0) and error <= 1e-4, "Invalid native probability simplex")
            labels[z:end] = ct_normalized_argmax(slab, sums)
            del slab, sums
            emit("native_blocks", current=end, total=labels.shape[0])
        label = runtime.LabelVolume(labels, native.geometry, runtime.ONTOLOGY_ID)
        qc = {"status": "passed", "native_voxel_centers_covered": True, "probability_channels": 33,
              "simplex_max_error_before_renormalization": error, "anti_alias": parameters.to_dict(),
              "argmax_grid": "native", "interpolation": "linear_per_class", "outside_values": [1.] + [0.] * 32,
              "renormalized": True, "fallback": None, "storage": "streamed_native_blocks",
              "native_block_depth": depth}
        emit("result_export_start")
        return label, qc
    return inverse


def ct_case_id(value):
    # The vendor rejects leading digits and eight consecutive digits (date-like IDs).
    # Retain 128 bits of identity while leaving room for Windows transaction filenames.
    return "case_" + hashlib.sha256(value.encode("utf8")).hexdigest()[:32].translate(str.maketrans("0123456789", "ghijklmnop"))


def ct_torch(root, device):
    """Reuse bundled Blackwell-capable torch; retain CT's pinned MONAI recipe."""
    if device not in ("cpu", "cuda:0"):
        raise ValueError("Unsupported CT device")
    if device == "cuda:0":
        site = str(root.parents[1] / "envs/ap/Lib/site-packages")
        if not (Path(site) / "torch/__init__.py").is_file():
            raise RuntimeError("CT CUDA runtime is missing; CPU fallback is disabled")
        sys.path.insert(0, site)
        try:
            import torch
        finally:
            sys.path.remove(site)
        if not torch.cuda.is_available():
            raise RuntimeError("CT CUDA is unavailable; CPU fallback is disabled")
    else:
        import torch
    return torch


def run_ct(root, job):
    device = job.get("device", "cuda:0")
    emit("model_loading", device=device)
    torch = ct_torch(root, device)
    import numpy as np
    import SimpleITK as sitk
    control = getattr(_context, "control", None)
    runtime = load_module("exmo_ct_vendor_" + (control.ident if control else "single"), root / "run.py")
    from thigh_muscle_seg_ct.core import atomic
    from thigh_muscle_seg_ct.core.artifacts import identifier
    windows_transactions(atomic)
    cfg = read(root / "configs/inference.json")
    torch.set_num_threads(4)
    sitk.ProcessObject.SetGlobalDefaultNumberOfThreads(4)
    torch.manual_seed(cfg["seed"])
    np.random.seed(cfg["seed"])
    torch.use_deterministic_algorithms(True)
    torch.backends.cudnn.benchmark = False
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    source = Path(job["input"])
    case_id = identifier(ct_case_id(job["id"]))
    case = {"case_id": case_id, "input": str(source), "input_sha256": runtime.sha256_file(source)}
    for name in ("hu_evidence", "source_proof"):
        case[name + "_sha256"] = runtime.sha256_file(source.parent / (name + ".json"))
    (model, model_hash), reused = cached_model(("ct", str(root), device),
        [root / "model/trial_230704_4_best.pth", root / "configs/inference.json"],
        lambda: runtime.model_for(cfg, device))
    microbatch = int(job.get("ct_microbatch", 4))
    if microbatch not in (1, 2, 4):
        raise ValueError("Unsupported CT predictor microbatch")
    execution = {"device": device, "torch": torch.__version__, "precision": "float32",
                 "tf32": False, "amp": False, "model_reused": reused,
                 "predictor_microbatch": microbatch if device != "cpu" else None}
    job["execution"] = execution
    progress = {"done": 0, "total": 0, "last": 0.0}
    if device != "cpu":
        execution.update(cuda=torch.version.cuda, gpu=torch.cuda.get_device_name(0))
        emit("model_loading", device=device, gpu=execution["gpu"], precision="float32")
        torch.cuda.reset_peak_memory_stats()
        original_model = model

        class Microbatch(torch.nn.Module):
            def forward(self, patches):
                # Preserve sliding-window order/blending, but bound GPU activation memory.
                values = []
                for patch in patches.split(microbatch):
                    values.append(original_model(patch))
                    progress["done"] += len(patch)
                    now = time.monotonic()
                    if now - progress["last"] >= 1 or progress["done"] == progress["total"]:
                        emit("inference_progress", patches_done=progress["done"], patches_total=progress["total"])
                        progress["last"] = now
                return torch.cat(values, dim=0)

        model = Microbatch().eval()
    output = Path(job["output"])
    output.mkdir(parents=True, exist_ok=False)
    inverse = ct_inverse(runtime, output)
    def pipelined_inverse(probability, native):
        cpu_phase(job, torch)
        return inverse(probability, native)
    runtime.inverse = pipelined_inverse
    def traced(stage, function):
        def call(*args, **kwargs):
            emit(stage)
            return function(*args, **kwargs)
        return call
    runtime.save_nifti = traced("result_save", runtime.save_nifti)
    runtime.export_segmentation = traced("result_save", runtime.export_segmentation)
    runtime.quantify = traced("result_measurement", runtime.quantify)
    runtime.read_segmentation = traced("result_verification", runtime.read_segmentation)
    def log(event, **value):
        if event == "inference_start":
            progress["total"] = value["patches"]
        if device != "cpu" and event == "inference_progress":
            return
        emit(event, **value)
    runtime.log = log
    runtime.run_case(case, cfg, model, model_hash, device, output, 4)
    if device != "cpu" and "peak_gpu_memory_bytes" not in execution:
        execution["peak_gpu_memory_bytes"] = torch.cuda.max_memory_allocated()
    job["execution"] = execution
    return output / case_id


def prepare_execution(torch, job):
    """Fail closed on unavailable CUDA; report the actual runtime for every model."""
    device = job.get("device", "cuda:0")
    if device not in ("cpu", "cuda:0"):
        raise ValueError("Unsupported inference device")
    precision = "mixed_float16" if device != "cpu" and job.get("route") in ("LAT_LT", "LAT_RT") else "float32"
    execution = {"device": device, "torch": torch.__version__, "precision": precision}
    if device != "cpu":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable; CPU fallback is disabled")
        torch.cuda.set_device(0)
        torch.cuda.reset_peak_memory_stats()
        execution.update(cuda=torch.version.cuda, gpu=torch.cuda.get_device_name(0))
    job["execution"] = execution
    emit("model_loading", device=device, gpu=execution.get("gpu"), precision=precision)
    return device


def run_mri(root, job):
    import torch
    device = prepare_execution(torch, job)
    job["execution"]["precision"] = "float32"
    control = getattr(_context, "control", None)
    runtime = load_module("exmo_mri_vendor_" + (control.ident if control else "single"), root / "run_inference.py")
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
        if not getattr(slicer_export, "_desktop_windows_export_ready", False):
            source = inspect.getsource(slicer_export.export_slicer_segmentation)
            directory_flush = "        directory_fd = os.open(parent, os.O_RDONLY)\n        try:\n            os.fsync(directory_fd)\n        finally:\n            os.close(directory_fd)"
            if source.count('temporary.open("rb")') != 1 or source.count(directory_flush) != 1:
                raise RuntimeError("Unexpected MRI export implementation; Windows adaptation blocked")
            # Windows _commit needs a writable fd. Adapt only the temporary-output open
            # and POSIX directory fsync; header creation and readback checks are unchanged.
            source = source.replace('temporary.open("rb")', 'temporary.open("r+b")').replace(directory_flush, "        _desktop_fsync_directory(parent)")
            slicer_export._desktop_fsync_directory = atomic._fsync_directory
            exec(compile(source, slicer_export.__file__, "exec"), slicer_export.__dict__)
            slicer_export._desktop_windows_export_ready = True
        runtime.export_slicer_segmentation = slicer_export.export_slicer_segmentation
    torch.set_num_threads(4)
    base_predictor = runtime.TorchModelPredictor
    class PipelinePredictor(base_predictor):
        desktop_calls = 0
        def predict_logits(self, *args, **kwargs):
            value = super().predict_logits(*args, **kwargs)
            self.desktop_calls += 1
            if self.desktop_calls == 2:
                # Both original FP32 TTA passes are complete; no later model calls.
                if control is not None:
                    self.model.to("cpu")
                cpu_phase(job, torch)
            return value
    runtime.TorchModelPredictor = PipelinePredictor
    emit("inference_start", device=device)
    # Keep native full6 FP32, both TTA passes, raw + PP500. No hidden fallback.
    runtime.run([(job["id"], Path(job["input"]))], Path(job["output"]), device)
    return Path(job["output"]) / job["id"]


def run_ap(root, job):
    import torch
    selected_device = prepare_execution(torch, job)
    sys.path.insert(0, str(root / "code"))
    import InferenceLOWEX_slicer_nrrd as legacy
    torch.set_num_threads(4)
    names, size = legacy.get_class_names("AP"), legacy.get_target_size("AP")
    checkpoint = root / "models/AP/model.pth"
    device = torch.device(selected_device)
    emit("model_loading", device=str(device))
    def load_ap():
        candidate = legacy.build_model("vnet", len(names), size, "AP").to(device)
        return legacy.load_checkpoint_to_model(candidate, checkpoint, device)[0]
    model, reused = cached_model(("ap", str(root), str(device)), [checkpoint], load_ap)
    job["execution"]["model_reused"] = reused
    model.eval()
    output = Path(job["output"])
    output.mkdir(parents=True, exist_ok=False)
    emit("inference_start")
    # Keep the original function, not a previous job's handoff wrapper.
    infer = getattr(legacy, "_desktop_original_infer", legacy.infer_mask_from_tensor)
    legacy._desktop_original_infer = infer
    def infer_then_handoff(*args, **kwargs):
        value = infer(*args, **kwargs)
        cpu_phase(job, torch)
        return value
    legacy.infer_mask_from_tensor = infer_then_handoff
    result = legacy.run_inference_case(Path(job["input"]), "AP", output, model, checkpoint, "vnet", names, len(names), size, device, .55, True, output_prefix="case")
    import shutil
    shutil.copyfile(result["mask_path"], output / "mask.seg.nrrd")
    metrics = read(result["json_path"])
    metrics.update(volume_cm3=None, volume_status="unsupported_2d_projection", tta="none")
    (output / "metrics.json").write_text(json.dumps(metrics), encoding="utf-8")
    return output


def run_lat(root, job):
    import torch
    selected_device = prepare_execution(torch, job)
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
    device = torch.device(selected_device)
    emit("model_loading", device=str(device))
    # ponytail: one GPU job; retain five folds, mirroring and the original patch size.
    def load_lat():
        predictor = nnUNetPredictor(tile_step_size=.5, use_gaussian=True, use_mirroring=True,
            perform_everything_on_device=False, device=device, verbose=False, verbose_preprocessing=False, allow_tqdm=False)
        predictor.initialize_from_trained_model_folder(str(root / "models" / route), (0, 1, 2, 3, 4), checkpoint_name="checkpoint_final.pth")
        return predictor
    predictor, reused = cached_model(("lat", str(root), route, str(device)),
        [root / "models" / route / f"fold_{fold}" / "checkpoint_final.pth" for fold in range(5)], load_lat)
    job["execution"]["model_reused"] = reused
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
    cpu_phase(job, torch)
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


def peak_host_process_memory():
    if os.name != "nt":
        return None
    class Counters(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_ulong), ("faults", ctypes.c_ulong)] + [(name, ctypes.c_size_t) for name in
            ("peak_working_set", "working_set", "peak_paged", "paged", "peak_nonpaged", "nonpaged", "pagefile", "peak_pagefile")]
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    function = ctypes.WinDLL("psapi").GetProcessMemoryInfo
    function.argtypes = (ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong)
    if not function(ctypes.c_void_p(-1), ctypes.byref(counters), counters.cb):
        return None
    return int(counters.peak_working_set)


def run_job(engine_root, job):
    start = time.monotonic()
    modality = job["analysis"]
    package = {"ct": "EXMO_CT", "mri": "EXMO_MRI", "xray": "EXMO_XRAY"}[modality]
    root = engine_root / "packages" / package
    handler = {"ct": run_ct, "mri": run_mri, "xray": run_ap if job.get("route") == "AP" else run_lat}[modality]
    result = handler(root, job)
    if job.get("execution", {}).get("device") == "cuda:0" and "peak_gpu_memory_bytes" not in job["execution"]:
        import torch
        torch.cuda.synchronize()
        job["execution"]["peak_gpu_memory_bytes"] = torch.cuda.max_memory_allocated()
        if job["execution"]["peak_gpu_memory_bytes"] <= 0:
            raise RuntimeError("GPU execution did not allocate CUDA memory")
    identity = {"schema": 1, "analysis": modality, "route": job.get("route"), "seconds": time.monotonic() - start,
                "adapter": "EXMO_WINDOWS_V1", "adapter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "complete": True,
                "execution": job.get("execution", {"device": job.get("device", "cuda:0")}),
                "peak_host_process_memory_bytes": peak_host_process_memory()}
    (result / "desktop-complete.json").write_text(json.dumps(identity), encoding="utf-8")
    emit("complete", result=str(result), **identity)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-root", type=Path, required=True)
    parser.add_argument("--job", type=Path, required=True)
    args = parser.parse_args()
    run_job(args.engine_root, read(args.job))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Private stderr is retained by main for local diagnostics; never forwarded to renderer.
        import traceback
        traceback.print_exc()
        emit("failed")
        sys.exit(1)

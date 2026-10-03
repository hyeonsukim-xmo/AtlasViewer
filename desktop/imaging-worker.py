"""Private volume inspection, reslicing and result publication. No masks cross IPC."""
from __future__ import annotations

import argparse
import ast
import base64
from collections import OrderedDict
import hashlib
import importlib.util
import io
import itertools
import json
import math
from pathlib import Path
import shutil
import sys
import uuid

import nibabel as nib
import nrrd
import numpy as np
import pydicom
import SimpleITK as sitk
from PIL import Image

sitk.ProcessObject.SetGlobalDefaultNumberOfThreads(2)
MAX_VOXELS = 256_000_000


class InputError(ValueError):
    pass


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8")


def digest(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def valid_geometry(image):
    if image.GetDimension() != 3 or image.GetNumberOfComponentsPerPixel() != 1:
        raise InputError("3차원 단일 채널 영상이 필요합니다. 4D·다중 채널 영상은 지원하지 않습니다.")
    size, spacing = image.GetSize(), image.GetSpacing()
    if any(n < 1 for n in size) or math.prod(size) > MAX_VOXELS:
        raise InputError("지원하는 영상 크기를 벗어났습니다 (최대 2억 5,600만 voxel).")
    direction = np.array(image.GetDirection()).reshape(3, 3)
    if not np.isfinite([*spacing, *image.GetOrigin(), *direction.ravel()]).all() or min(spacing) <= 0:
        raise InputError("유효한 mm 단위 spacing·origin·direction이 필요합니다.")
    if not np.allclose(direction.T @ direction, np.eye(3), atol=1e-4):
        raise InputError("Shear가 포함된 geometry는 현재 모델 입력으로 지원하지 않습니다.")


def load_image(path, volume=True, metadata_only=False):
    path = Path(path)
    if path.name.lower().endswith((".nii", ".nii.gz")):
        ni = nib.load(path)
        q, qc = ni.get_qform(coded=True)
        s, sc = ni.get_sform(coded=True)
        if len(ni.shape) != 3 or math.prod(ni.shape) > MAX_VOXELS or ni.header.get_xyzt_units()[0] != "mm" or not (qc or sc):
            raise InputError("NIfTI는 mm 단위의 coded affine이 있는 3D 영상이어야 합니다.")
        if qc and sc and not np.allclose(q, s, atol=1e-3):
            raise InputError("NIfTI qform과 sform이 일치하지 않습니다. 좌표계를 확인하세요.")
    elif path.suffix.lower() == ".nrrd":
        header = nrrd.read_header(str(path))
        if "data file" in header:
            raise InputError("분리된 NRRD header는 지원하지 않습니다. 데이터가 포함된 파일을 선택하세요.")
        if math.prod(int(n) for n in header["sizes"]) > MAX_VOXELS:
            raise InputError("지원하는 영상 크기를 벗어났습니다.")
        if volume and ("space origin" not in header or "space directions" not in header or "space" not in header):
            raise InputError("3D NRRD에 space·origin·direction 정보가 필요합니다.")
        units = header.get("space units")
        if units is not None and any(str(u).strip('"') != "mm" for u in units):
            raise InputError("mm 단위 geometry만 지원합니다.")
    reader = sitk.ImageFileReader()
    reader.SetFileName(str(path))
    reader.ReadImageInformation()
    if reader.GetDimension() != 3 or math.prod(reader.GetSize()) > MAX_VOXELS:
        raise InputError("지원하는 3D 영상 형식과 크기를 확인하세요.")
    if metadata_only:
        if reader.GetNumberOfComponents() != 1 or min(reader.GetSize()) < 2:
            raise InputError("CT/MRI 분석에는 3D volume이 필요합니다.")
        geometry = sitk.Image([1, 1, 1], sitk.sitkUInt8)
        geometry.SetSpacing(reader.GetSpacing())
        geometry.SetOrigin(reader.GetOrigin())
        geometry.SetDirection(reader.GetDirection())
        valid_geometry(geometry)
        return reader
    image = reader.Execute()
    valid_geometry(image)
    data = sitk.GetArrayViewFromImage(image)
    if not np.isfinite(data).all() or np.ptp(data) <= 0:
        raise InputError("영상에 유효하지 않은 값이 있거나 명암 대비가 없습니다.")
    if volume and min(image.GetSize()) < 2:
        raise InputError("CT/MRI 분석에는 3D volume이 필요합니다.")
    return image


IMAGE_CACHE_LIMIT = 512 * 1024 ** 2
image_cache = OrderedDict()
image_cache_bytes = 0


def cached_image(path):
    global image_cache_bytes
    key = str(path)
    if key in image_cache:
        image_cache.move_to_end(key)
        return image_cache[key][0]
    image = sitk.ReadImage(key)
    size = sitk.GetArrayViewFromImage(image).nbytes
    while image_cache and (image_cache_bytes + size > IMAGE_CACHE_LIMIT or len(image_cache) >= 6):
        _, (_, removed) = image_cache.popitem(last=False)
        image_cache_bytes -= removed
    if size <= IMAGE_CACHE_LIMIT:
        image_cache[key] = (image, size)
        image_cache_bytes += size
    return image


def clear_image_cache():
    global image_cache_bytes
    image_cache.clear()
    image_cache_bytes = 0


def dicom_series(paths, analysis):
    groups, other = {}, []
    for path in paths:
        if str(path).lower().endswith((".nrrd", ".nii", ".nii.gz")):
            other.append([path])
            continue
        try:
            header = pydicom.dcmread(path, stop_before_pixels=True)
            study, series = str(header.StudyInstanceUID), str(header.SeriesInstanceUID)
            key = (study, series, str(path) if analysis == "xray" else "")
            groups.setdefault(key, []).append(path)
        except Exception:
            other.append([path])
    return list(groups.values()) + other


def read_dicom(paths, analysis):
    headers = [pydicom.dcmread(path, stop_before_pixels=True) for path in paths]
    first = headers[0]
    expected = {"ct": ("CT",), "mri": ("MR",), "xray": ("DX", "CR")}[analysis]
    if any(str(getattr(h, "Modality", "")) not in expected for h in headers):
        raise InputError("선택한 분석의 modality와 DICOM modality가 일치하지 않습니다.")
    if any(int(getattr(h, "NumberOfFrames", 1)) != 1 or int(getattr(h, "SamplesPerPixel", 1)) != 1 for h in headers):
        raise InputError("Enhanced/multiframe·컬러 DICOM은 현재 지원하지 않습니다.")
    count = sum(int(h.Rows) * int(h.Columns) for h in headers)
    if count > MAX_VOXELS:
        raise InputError("DICOM series가 지원 크기를 초과했습니다.")
    metadata = {"caseName": str(getattr(first, "PatientName", ""))[:120],
                "studyDescription": str(getattr(first, "StudyDescription", ""))[:300],
                "seriesDescription": str(getattr(first, "SeriesDescription", ""))[:300],
                "studyDate": str(getattr(first, "StudyDate", ""))[:20], "format": "DICOM"}
    if analysis == "xray":
        if len(paths) != 1:
            raise InputError("X-ray는 단일 projection만 지원합니다.")
        image = sitk.ReadImage(str(paths[0]))
        if image.GetDimension() == 2:
            image = sitk.JoinSeries(image)
        valid_geometry(image)
        return image, metadata
    if len(paths) < 2:
        raise InputError("CT/MRI DICOM은 전체 series가 담긴 폴더를 선택하세요.")
    if any(not hasattr(h, "ImageOrientationPatient") or not hasattr(h, "ImagePositionPatient") or not hasattr(h, "PixelSpacing") for h in headers):
        raise InputError("DICOM 공간 좌표·pixel spacing이 누락되었습니다.")
    orientation = np.array(first.ImageOrientationPatient, dtype=float)
    normal = np.cross(orientation[:3], orientation[3:])
    if not np.isclose(np.linalg.norm(normal), 1, atol=1e-4):
        raise InputError("DICOM 방향 벡터가 올바르지 않습니다.")
    for h in headers:
        if (str(h.FrameOfReferenceUID) != str(first.FrameOfReferenceUID)
            or (h.Rows, h.Columns) != (first.Rows, first.Columns)
            or not np.allclose(h.ImageOrientationPatient, orientation, atol=1e-5)
            or not np.allclose(h.PixelSpacing, first.PixelSpacing, atol=1e-5)):
            raise InputError("한 Series 안에 서로 다른 geometry가 있습니다. 원본 series를 확인하세요.")
    order = sorted(range(len(paths)), key=lambda i: np.dot(headers[i].ImagePositionPatient, normal))
    points = np.array([headers[i].ImagePositionPatient for i in order], dtype=float)
    gaps = np.diff(points @ normal)
    if min(gaps) <= 1e-4 or not np.allclose(gaps, np.median(gaps), rtol=1e-3, atol=.01):
        raise InputError("중복·누락 slice 또는 불균일한 slice 간격이 있습니다.")
    if not np.allclose(np.diff(points, axis=0), gaps[:, None] * normal, atol=.05):
        raise InputError("Gantry tilt/shear series는 현재 지원하지 않습니다.")
    if analysis == "ct" and any(str(getattr(h, "RescaleType", "HU")).upper() != "HU" for h in headers):
        raise InputError("CT rescale 단위가 HU가 아닙니다.")
    if analysis == "ct" and any(not hasattr(h, "RescaleSlope") or not hasattr(h, "RescaleIntercept") or not np.isfinite([float(h.RescaleSlope), float(h.RescaleIntercept)]).all() or float(h.RescaleSlope) == 0 for h in headers):
        raise InputError("CT rescale slope/intercept를 확인할 수 없습니다. HU 복원을 확인하세요.")
    reader = sitk.ImageSeriesReader()
    reader.SetFileNames([str(paths[i]) for i in order])
    image = reader.Execute()  # GDCM applies each DICOM rescale exactly once.
    valid_geometry(image)
    metadata["_sourceProof"] = {"study_uid": str(first.StudyInstanceUID), "series_uid": str(first.SeriesInstanceUID),
        "frames": [{"sop_uid": str(headers[i].SOPInstanceUID), "sha256": digest(paths[i]),
                    "slope": float(getattr(headers[i], "RescaleSlope", 1)), "intercept": float(getattr(headers[i], "RescaleIntercept", 0)),
                    "position_lps_mm": list(map(float, headers[i].ImagePositionPatient))} for i in order]}
    return image, metadata


def inspect(message, root, classifier):
    analysis = message["analysis"]
    destination = Path(message["destination"])
    destination.mkdir(parents=True, exist_ok=False)
    rows = []
    for paths in dicom_series([Path(p) for p in message["paths"]], analysis):
        ident = uuid.uuid4().hex
        directory = destination / ident
        directory.mkdir()
        names = message.get("names", {})
        name = names.get(str(paths[0]), paths[0].name)
        record = {"id": ident, "name": name, "analysis": analysis, "ready": False, "warnings": []}
        try:
            is_dicom = not paths[0].name.lower().endswith((".nrrd", ".nii", ".nii.gz"))
            metadata = {"format": "NRRD" if paths[0].suffix.lower() == ".nrrd" else "NIfTI", "caseName": name}
            if is_dicom:
                image, fields = read_dicom(paths, analysis)
                metadata.update(fields)
            else:
                deferred = analysis == "ct" and paths[0].suffix.lower() == ".nrrd"
                image = load_image(paths[0], volume=analysis != "xray", metadata_only=deferred)
            size, spacing = image.GetSize(), image.GetSpacing()
            if analysis == "xray" and size[2] != 1:
                raise InputError("X-ray는 Z=1인 projection만 지원합니다.")
            deferred = not is_dicom and analysis == "ct" and paths[0].suffix.lower() == ".nrrd"
            source = directory / ("input.nii.gz" if analysis == "ct" and not deferred else "input.nrrd")
            if deferred:
                # Only main's private snapshots may be moved; standalone callers keep originals.
                if message.get("consumeSnapshots"):
                    shutil.move(str(paths[0]), str(source))
                else:
                    shutil.copyfile(paths[0], source)
                record["deferredValidation"] = True
                record["warnings"].append("영상 전체 검증은 분석 실행 전에 수행됩니다.")
            elif not is_dicom and ((analysis == "ct" and paths[0].name.lower().endswith((".nii", ".nii.gz"))) or paths[0].suffix.lower() == ".nrrd" and analysis != "ct"):
                source = directory / ("input.nii" if paths[0].suffix.lower() == ".nii" else source.name)
                shutil.copyfile(paths[0], source)
            else:
                sitk.WriteImage(image, str(source), True)
            metadata.update(size=list(size), spacing=list(spacing), slices=size[2], seriesDescription=metadata.get("seriesDescription") or name,
                            studyDescription=metadata.get("studyDescription") or "", caseName=metadata.get("caseName") or name)
            record.update(input=str(source), metadata=metadata, ready=True)
            record["sourceProof"] = metadata.pop("_sourceProof", None)
            if deferred:
                record.update(confirmation="hu", evidence=None)
            elif analysis == "ct":
                source_sha = digest(source)
                known = next((c for c in read_json(root / "packages/EXMO_CT/samples/manifest.json")["cases"] if c["input_sha256"] == source_sha), None)
                evidence = "DICOM_RESCALE_HU" if is_dicom else "BOUND_DELIVERY_SAMPLE" if known else None
                record.update(confirmation=None if evidence else "hu", evidence=evidence, source_sha256=source_sha)
                if known:
                    sample = root / "packages/EXMO_CT" / known["input"]
                    for filename in ("hu_evidence.json", "source_proof.json"):
                        shutil.copyfile(sample.parent / filename, directory / filename)
            elif analysis == "mri":
                source_sha = digest(source)
                known = any(digest(root / "packages/EXMO_MRI" / c["input"]) == source_sha for c in read_json(root / "packages/EXMO_MRI/samples/manifest.json"))
                record.update(confirmation=None if known else "water", source_sha256=source_sha)
            else:
                classification = classifier.process({"operation": "classify", "path": str(paths[0])}, classifier.pipeline)
                record["classification"] = classification
                raw_header = nrrd.read_header(str(source))
                record["areaAvailable"] = "space directions" in raw_header and (not is_dicom or hasattr(pydicom.dcmread(paths[0], stop_before_pixels=True), "PixelSpacing"))
                if not classification["route_to_segmentation"]:
                    record.update(ready=False, error="촬영 방향 검토가 필요합니다. Parts/낮은 분류 신뢰도 입력은 분석에서 제외됩니다.")
                # Original AP's NRRD restoration is verified only for this source-grid convention.
                if classification["route_to_segmentation"] == "AP" and (is_dicom or not np.allclose(image.GetDirection(), np.eye(3).ravel(), atol=1e-5)):
                    record.update(ready=False, error="AP 모델의 DICOM/변형 방향 복원은 아직 검증되지 않았습니다. LPS 원본 NRRD를 사용하세요.")
                if is_dicom and classification["route_to_segmentation"] != "AP":
                    record.update(ready=False, error="측면 모델은 제공된 NRRD 입력 recipe만 검증되었습니다. X-ray NRRD를 사용하세요.")
                if not is_dicom and "space origin" not in nrrd.read_header(str(source)):
                    record["warnings"].append("원본에 origin 정보 없음 · projection 좌표로 표시")
            write_json(directory / "input.json", record)
        except InputError as error:
            record.update(ready=False, error=str(error))
        except Exception:
            import traceback
            traceback.print_exc(file=sys.stderr)
            record.update(ready=False, error="영상의 형식·metadata·geometry를 읽지 못했습니다. 원본 파일과 series 구성을 확인하세요.")
        rows.append(record)
    write_json(destination / "index.json", rows)
    return rows


def plane(image, view, index):
    size = image.GetSize()
    corners = np.array([image.TransformIndexToPhysicalPoint(tuple(int(v) for v in p)) for p in itertools.product(*[(0, n - 1) for n in size])])
    lower, upper = corners.min(axis=0), corners.max(axis=0)
    axis, u, v, sides = {"axial": (2, (1, 0, 0), (0, 1, 0), ["R", "L", "A", "P"]),
                        "coronal": (1, (1, 0, 0), (0, 0, -1), ["R", "L", "S", "I"]),
                        "sagittal": (0, (0, 1, 0), (0, 0, -1), ["A", "P", "S", "I"])}[view]
    normal = np.zeros(3); normal[axis] = 1
    step = 1 / np.linalg.norm(np.linalg.inv(np.array(image.GetDirection()).reshape(3, 3) @ np.diag(image.GetSpacing())) @ normal)
    count = max(1, int(round((upper[axis] - lower[axis]) / step)) + 1)
    index = count // 2 if index is None else min(count - 1, max(0, int(index)))
    u, v = np.array(u), np.array(v)
    start = np.where(u + v < 0, upper, lower)
    start[axis] = lower[axis] + index * (upper[axis] - lower[axis]) / max(1, count - 1)
    extent = upper - lower
    width, height = float(abs(extent @ u)), float(abs(extent @ v))
    pixel = max(min(image.GetSpacing()), max(width, height) / 900)
    direction = np.column_stack((u, v, np.cross(u, v)))
    reference = sitk.Image([max(1, int(round(width / pixel)) + 1), max(1, int(round(height / pixel)) + 1), 1], sitk.sitkFloat32)
    reference.SetSpacing((pixel, pixel, 1))
    reference.SetOrigin(tuple(start))
    reference.SetDirection(tuple(float(value) for value in direction.ravel()))
    return reference, index, count, sides


def preview(message):
    record = message["record"]
    image = cached_image(record["input"])
    selected = message.get("classIds")
    overlay_path = message.get("mask")
    rows = message.get("rows", [])
    side = message.get("side", "all")
    if side != "all":
        if side not in SIDE_CODES or not message.get("sideMask"):
            raise InputError("이 결과의 좌우 정보를 먼저 준비하세요.")
        overlay_path = message["sideMask"]
        rows = [{**row, "label": row["label"] * 3 + SIDE_CODES[side]} for row in rows]
        if selected is not None: selected = [cid * 3 + SIDE_CODES[side] for cid in selected]
    view = message.get("view", "axial")
    if view not in ("axial", "coronal", "sagittal"):
        raise InputError("지원하지 않는 보기 방향입니다.")
    if record["analysis"] == "xray":
        array = sitk.GetArrayViewFromImage(image)[0]
        index, count, sides, reference = 0, 1, [], None
    else:
        reference, index, count, sides = plane(image, view, message.get("index"))
        array = sitk.GetArrayFromImage(sitk.Resample(image, reference, sitk.Transform(), sitk.sitkLinear, -1024 if record["analysis"] == "ct" else 0))[0]
    window = message.get("window", "soft")
    if record["analysis"] == "ct":
        lo, hi = (-160, 240) if window != "bone" else (-500, 1500)
    else:
        finite = array[np.isfinite(array)]
        lo, hi = np.percentile(finite, [.5, 99.5])
    gray = (np.clip((array.astype(np.float32) - lo) / max(hi - lo, 1e-5), 0, 1) * 255).astype(np.uint8)
    display = Image.fromarray(gray).convert("RGB")
    display.thumbnail((1000, 1000), Image.Resampling.BILINEAR)
    if overlay_path:
        mask = cached_image(overlay_path)
        if reference is None:
            labels = sitk.GetArrayViewFromImage(mask)[0]
        else:
            labels = sitk.GetArrayFromImage(sitk.Resample(mask, reference, sitk.Transform(), sitk.sitkNearestNeighbor, 0))[0]
        label_image = Image.fromarray(labels.astype(np.uint8)).resize(display.size, Image.Resampling.NEAREST)
        small = np.asarray(label_image)
        rgb = np.array(display, dtype=np.float32)
        alpha = float(message.get("opacity", .45))
        if not 0 <= alpha <= 1:
            raise InputError("잘못된 overlay opacity입니다.")
        colors = np.zeros((256, 3), dtype=np.int64)
        active = np.zeros(256, dtype=bool)
        for row in rows:
            colors[row["label"]] = [int(row["color"][n:n + 2], 16) for n in (1, 3, 5)]
            active[row["label"]] = selected is None or row["label"] in selected
        region = active[small]
        rgb[region] = rgb[region] * (1 - alpha) + colors[small[region]] * alpha
        display = Image.fromarray(rgb.astype(np.uint8))
    buffer = io.BytesIO()
    display.save(buffer, format="PNG", compress_level=1)
    return {"image": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode(),
            "index": index, "count": count, "view": view, "sides": sides, "metadata": record["metadata"], "warnings": record.get("warnings", [])}


def canonical(name):
    value = name.lower().replace(" ", "_")
    return {"tensor_fascia_latae": "tensor_fascia_latae", "tensor_fasciae_latae": "tensor_fascia_latae", "multifidus": "mulifidus", "femur": "femoral"}.get(value, value)


LATERALITY_METHOD = "femur_components_lps_v1"
SIDE_CODES = {"unassigned": 0, "left": 1, "right": 2}


def laterality_reference(mask, femur_label):
    """Review heuristic anchored to paired femora, never array midpoint or LPS x=0."""
    from scipy import ndimage
    labels = sitk.GetArrayViewFromImage(mask)
    components, _ = ndimage.label(labels == femur_label, np.ones((3, 3, 3)))
    sizes = np.bincount(components.ravel()); sizes[0] = 0
    ranked = np.argsort(sizes)[::-1]
    if (len(ranked) < 2 or sizes[ranked[1]] < max(20, sizes[ranked[0]] * .15)
            or (len(ranked) > 2 and sizes[ranked[2]] > sizes[ranked[1]] * .2)):
        return {"status": "unavailable", "reason": "양측 대퇴골 기준을 확인할 수 없음"}
    affine = np.array(mask.GetDirection()).reshape(3, 3) @ np.diag(mask.GetSpacing())
    points = [np.argwhere(components == cid)[:, ::-1] @ affine.T + mask.GetOrigin() for cid in ranked[:2]]
    points.sort(key=lambda p: p[:, 0].mean())  # LPS +X is patient left, independent of voxel storage.
    right, left = points
    separation = left.mean(axis=0) - right.mean(axis=0)
    normal = separation[:2] / max(np.linalg.norm(separation[:2]), 1e-8)
    if separation[0] < 30 or normal[0] < .7:
        return {"status": "unavailable", "reason": "대퇴골 쌍의 좌우 간격·방향이 불확실함"}
    lower = max(p[:, 2].min() for p in points)
    upper = min(p[:, 2].max() for p in points)
    extent = min(np.ptp(p[:, 2]) for p in points)
    if upper - lower < max(20, extent * .5):
        return {"status": "unavailable", "reason": "대퇴골 쌍의 촬영 범위가 충분히 겹치지 않음"}
    # Fit the midline along superior position to accommodate patient lean/oblique acquisitions.
    centres = []
    for p in points:
        bins = np.floor((p[:, 2] - lower) / 10).astype(int)
        centres.append({int(k): p[bins == k].mean(axis=0) for k in np.unique(bins) if 0 <= k <= (upper - lower) / 10})
    common = sorted(set(centres[0]) & set(centres[1]))
    if len(common) < 3:
        return {"status": "unavailable", "reason": "양측 대퇴골 기준 slice가 부족함"}
    mid = np.array([(centres[0][k] + centres[1][k]) / 2 for k in common])
    slope, offset = np.polyfit(mid[:, 2], mid[:, :2] @ normal, 1)
    residual = np.abs(mid[:, :2] @ normal - (mid[:, 2] * slope + offset))
    if np.quantile(residual, .9) > 10 or abs(slope) > .5:
        return {"status": "unavailable", "reason": "대퇴골 기준 중간면이 일정하지 않음"}
    return {"status": "estimated", "reason": "양측 대퇴골·환자 LPS 좌표 기준 자동 분류",
            "normal": [float(normal[0]), float(normal[1]), float(-slope)], "offset": float(offset),
            "residualMm": float(np.quantile(residual, .9))}


def split_laterality(mask, rows, reference, image=None, entropy=None):
    """Preserve every native voxel; crossing components stay unassigned instead of being cut."""
    from scipy import ndimage
    labels = sitk.GetArrayViewFromImage(mask)
    boxes = ndimage.find_objects(labels)
    output = (labels.astype(np.uint8) * 3)
    voxel = abs(float(np.linalg.det(np.array(mask.GetDirection()).reshape(3, 3)))) * math.prod(mask.GetSpacing()) / 1000
    affine = np.array(mask.GetDirection()).reshape(3, 3) @ np.diag(mask.GetSpacing())
    values = sitk.GetArrayViewFromImage(image) if image is not None else None
    uncertainty = sitk.GetArrayViewFromImage(entropy) if entropy is not None else None
    measurements = {}
    for row in rows:
        cid = row["label"]
        box = boxes[cid - 1] if cid <= len(boxes) else None
        flags = []
        if box is not None and reference["status"] == "estimated":
            region = labels[box] == cid
            cc, count = ndimage.label(region, np.ones((3, 3, 3)))
            positions = np.argwhere(region)
            xyz = (positions + np.array([s.start for s in box]))[:, ::-1]
            normal = np.array(reference["normal"])
            distance = ((xyz @ affine.T + mask.GetOrigin()) @ normal - reference["offset"]) / np.linalg.norm(normal)
            ids = cc[region]
            sizes = np.bincount(ids, minlength=count + 1)
            positive = np.bincount(ids, weights=distance > 2, minlength=count + 1)
            negative = np.bincount(ids, weights=distance < -2, minlength=count + 1)
            side = np.zeros(count + 1, dtype=np.uint8)
            # ponytail: whole-component spatial heuristic; fused/ambiguous regions require review,
            # not a speculative watershed split or an invented clinical confidence score.
            side[(sizes > 0) & (positive >= sizes * .98)] = 1
            side[(sizes > 0) & (negative >= sizes * .98)] = 2
            output[box][region] += side[ids]
        sides = {}
        for name, code in SIDE_CODES.items():
            region = output[box] == cid * 3 + code if box is not None else np.zeros(0, dtype=bool)
            count = int(region.sum())
            sides[name] = {"count": count, "value": count * voxel,
                           "fat": float(np.mean((values[box][region] >= -190) & (values[box][region] <= -30)) * 100) if count and values is not None else None,
                           "hu": float(values[box][region].mean()) if count and values is not None else None,
                           "entropy": float(uncertainty[box][region].mean()) if count and uncertainty is not None else None}
        if sides["unassigned"]["count"]: flags.append("좌우 판정 보류 영역 포함")
        if not sides["left"]["count"] or not sides["right"]["count"]: flags.append("양측 검출 미확인")
        left, right = sides["left"]["value"], sides["right"]["value"]
        complete = left > 0 and right > 0 and not sides["unassigned"]["count"]
        measurements[row["id"]] = {**sides, "differenceCm3": abs(left - right) if complete else None,
                                   "differencePercent": abs(left - right) / ((left + right) / 2) * 100 if complete else None,
                                   "flags": flags}
        assert sum(s["count"] for s in sides.values()) == row["count"], "Laterality lost native voxels"
    result = sitk.GetImageFromArray(output); result.CopyInformation(mask)
    return result, measurements


def prepare_laterality(mask, rows, result, variant, analysis, image):
    """Private, versioned derived assets. Source mask/ontology and model outputs remain immutable."""
    mask_path = result / variant / "mask.nrrd" if analysis == "mri" else result / "mask.nii.gz"
    raw_path = result / "raw/mask.nrrd" if analysis == "mri" else mask_path
    signature = {"method": LATERALITY_METHOD, "maskHash": digest(mask_path), "referenceHash": digest(raw_path)}
    folder = result / f"laterality-{variant}-{LATERALITY_METHOD}"
    manifest = folder / "metrics.json"
    if manifest.exists() and (folder / "mask.nrrd").exists():
        saved = read_json(manifest)
        if saved.get("signature") == signature and (not saved["parts"] or (folder / "surface.glb").exists()):
            for row in rows: row["sides"] = saved["rows"][row["id"]]
            return folder, saved
    raw = mask if raw_path == mask_path else sitk.ReadImage(str(raw_path))
    if not same_geometry(raw, mask): raise InputError("좌우 기준 Raw mask의 geometry가 일치하지 않습니다.")
    femur = next((row["label"] for row in rows if row["id"] == "femoral"), None)
    reference = laterality_reference(raw, femur) if femur else {"status": "unavailable", "reason": "대퇴골 label 없음"}
    entropy = sitk.ReadImage(str(result / "entropy.nrrd")) if analysis == "mri" else None
    if entropy is not None and not same_geometry(entropy, mask): raise InputError("Entropy와 mask의 geometry가 일치하지 않습니다.")
    separated, measurements = split_laterality(mask, rows, reference, image if analysis == "ct" else None, entropy)
    parts = []
    for row in rows:
        row["sides"] = measurements[row["id"]]
        for side, code in SIDE_CODES.items():
            if row["sides"][side]["count"]:
                parts.append({"id": f"{row['id']}__{side}", "structureId": row["id"], "side": side,
                              "label": row["label"] * 3 + code, "name": row["name"] + {"left": " · Left", "right": " · Right", "unassigned": " · 미분류"}[side],
                              "color": row["color"], "group": row["group"],
                              "faceBudget": max(500, round(35000 * row["sides"][side]["count"] / row["count"]))})
    folder.mkdir(exist_ok=True)
    temporary = folder / "mask.tmp.nrrd"; sitk.WriteImage(separated, str(temporary), True); temporary.replace(folder / "mask.nrrd")
    mesh_bytes = make_mesh(separated, parts, folder / "surface.glb")
    unassigned = sum(m["unassigned"]["count"] for m in measurements.values())
    saved = {"signature": signature, "reference": reference, "rows": measurements, "parts": parts, "meshBytes": mesh_bytes,
             "info": {"method": LATERALITY_METHOD, "status": "unavailable" if reference["status"] == "unavailable" else "partial" if unassigned else "estimated",
                      "reason": reference["reason"], "unassignedCm3": sum(m["unassigned"]["value"] for m in measurements.values())}}
    write_json(folder / "metrics.tmp.json", saved); (folder / "metrics.tmp.json").replace(manifest)
    return folder, saved


def make_mesh(mask, rows, target):
    from scipy import ndimage
    from skimage.measure import marching_cubes
    import trimesh
    labels = sitk.GetArrayViewFromImage(mask)
    boxes = ndimage.find_objects(labels)
    affine = np.array(mask.GetDirection()).reshape(3, 3) @ np.diag(mask.GetSpacing())
    scene = trimesh.Scene()
    for row in rows:
        cid = row["label"]
        box = boxes[cid - 1] if cid <= len(boxes) else None
        if box is None:
            continue
        crop = np.pad((labels[box] == cid).astype(np.uint8), 1)
        vertices, faces, _, _ = marching_cubes(crop, .5, allow_degenerate=False)
        xyz = (vertices + np.array([s.start for s in box]) - 1)[:, ::-1]
        lps = xyz @ affine.T + np.array(mask.GetOrigin())
        # Front camera is +Z, superior is +Y, patient's left appears screen-right.
        # LPS -> (L,S,-P) is a proper rotation, preserving triangle winding.
        points = lps[:, [0, 2, 1]] * [1, 1, -1]
        mesh = trimesh.Trimesh(points, faces, process=False)
        budget = row.get("faceBudget", 35000)
        if len(faces) > budget:
            mesh = mesh.simplify_quadric_decimation(face_count=budget)
        scene.add_geometry(mesh, node_name=row["id"], geom_name=row["id"])
    if scene.is_empty:
        return None
    scene.export(str(target), file_type="glb")
    return target.stat().st_size


def same_geometry(a, b):
    return a.GetSize() == b.GetSize() and all(np.allclose(x, y, rtol=1e-5, atol=1e-3) for x, y in
        [(a.GetSpacing(), b.GetSpacing()), (a.GetDirection(), b.GetDirection()), (a.GetOrigin(), b.GetOrigin())])


def strong_candidate(result, root):
    """Review candidate only: reuse the delivered native-grid PP implementation."""
    from scipy import ndimage
    sys.path.insert(0, str(root / "packages/EXMO_MRI/src"))
    from thigh_muscle_seg.postprocessing.rules import PostprocessingRecipe, apply_postprocessing
    from thigh_muscle_seg.data.ontology import load_ontology
    from thigh_muscle_seg.spatial import LabelVolume, SpatialGeometry
    # Import only the volume reporter, not reporting.__init__'s unrelated report-card stack.
    spec = importlib.util.spec_from_file_location("exmo_mri_volume", root / "packages/EXMO_MRI/src/thigh_muscle_seg/reporting/volume.py")
    reporter = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = reporter
    spec.loader.exec_module(reporter)

    recipe_id = "EXMO_PP500_MUSCLE_TOP2_REVIEW_V1"
    folder = result / "strong"
    source_hash = digest(result / "raw/mask.nrrd")
    if (folder / "metrics.json").exists() and (folder / "mask.nrrd").exists():
        saved = read_json(folder / "metrics.json")
        if (saved.get("source_raw_sha256") == source_hash and
                saved.get("postprocessing", {}).get("recipe_id") == recipe_id and
                saved.get("mask_sha256") == digest(folder / "mask.nrrd")):
            return folder
    source = load_image(result / "raw/mask.nrrd")
    entropy = load_image(result / "entropy.nrrd")
    if not same_geometry(source, entropy):
        raise InputError("Raw mask와 entropy의 geometry가 일치하지 않습니다.")
    entropy_values = sitk.GetArrayViewFromImage(entropy)
    if not np.isfinite(entropy_values).all():
        raise InputError("Entropy에 유효하지 않은 값이 포함되어 있습니다.")
    geometry = SpatialGeometry(source.GetSize(), source.GetSpacing(), source.GetOrigin(),
                               tuple(tuple(row) for row in np.array(source.GetDirection()).reshape(3, 3)))
    # Factor det(direction @ diag(spacing)) to avoid a log-det rounding error at 500 mm³.
    voxel_mm3 = math.prod(source.GetSpacing()) * abs(float(np.linalg.det(geometry.direction_array())))
    # Candidate recipe approved for comparison; never replaces raw or infers laterality.
    recipe = PostprocessingRecipe(recipe_id, mode="combined", connectivity=6,
                                  minimum_volume_mm3={cid: 500 for cid in range(1, 29)},
                                  maximum_components={cid: 2 for cid in range(1, 24)})
    labels, pp = apply_postprocessing(sitk.GetArrayViewFromImage(source), voxel_volume_mm3=voxel_mm3, recipe=recipe)
    ontology = load_ontology(root / "packages/EXMO_MRI/configs/dataset/mri_thigh_29class_v001.json")
    metric = reporter.calculate_native_volumes(LabelVolume(labels, geometry, ontology_id=ontology.ontology_id), ontology).to_dict()
    for row in metric["classes"]:
        cid = row["label_id"]
        region = labels == cid
        sizes = np.array([], dtype=np.int64)
        if cid:
            components, count = ndimage.label(region)
            sizes = np.sort(np.bincount(components.ravel(), minlength=count + 1)[1:])[::-1]
        row.update(volume_cm3=row["volume_ml"], mean_entropy=float(entropy_values[region].mean()) if region.any() else None,
                   large_components_over_1ml=int(np.count_nonzero(sizes * voxel_mm3 > 1000)),
                   top_component_volumes_ml=(sizes[:6] * voxel_mm3 / 1000).tolist())
    foreground = labels > 0
    metric.update(postprocessing={**pp, "status": "candidate_unapproved",
                                 "minimum_volume_mm3": dict(recipe.minimum_volume_mm3),
                                 "maximum_components": dict(recipe.maximum_components)},
                  source_raw_sha256=source_hash,
                  foreground_mean_entropy=float(entropy_values[foreground].mean()) if foreground.any() else None,
                  qc_flags=[f"class_{r['label_id']}_more_than_two_large_components" for r in metric["classes"]
                            if r["label_id"] and r["large_components_over_1ml"] > 2])
    folder.mkdir(exist_ok=True)
    temporary = folder / "mask.tmp.nrrd"
    output = sitk.GetImageFromArray(labels)
    output.CopyInformation(source)
    sitk.WriteImage(output, str(temporary), True)
    temporary.replace(folder / "mask.nrrd")
    metric["mask_sha256"] = digest(folder / "mask.nrrd")
    write_json(folder / "metrics.tmp.json", metric)
    (folder / "metrics.tmp.json").replace(folder / "metrics.json")
    return folder


def finalize(message, root, palette):
    result = Path(message["result"])
    if not read_json(result / "desktop-complete.json").get("complete"):
        raise InputError("완료되지 않은 결과입니다.")
    record = message["record"]
    analysis = record["analysis"]
    variant = message.get("variant", "raw")
    if variant not in ("raw", "pp500", "strong") or (analysis != "mri" and variant != "raw"):
        raise InputError("지원하지 않는 결과 variant입니다.")
    folder = strong_candidate(result, root) if variant == "strong" else result / variant if analysis == "mri" else result
    mask_path = folder / ("mask.nii.gz" if analysis == "ct" else "mask.nrrd" if analysis == "mri" or record.get("classification", {}).get("route_to_segmentation") != "AP" else "mask.seg.nrrd")
    mask = sitk.ReadImage(str(mask_path))
    image = cached_image(record["input"])
    if not same_geometry(mask, image):
        raise InputError("결과와 원본 영상의 geometry가 일치하지 않습니다. 결과 표시를 중단했습니다.")
    labels = sitk.GetArrayViewFromImage(mask)
    counts = np.bincount(labels.ravel().astype(np.int64), minlength=33)
    metric = read_json(folder / "metrics.json") if (folder / "metrics.json").exists() else {}
    raw_metrics = {r["label_id"]: r for r in read_json(result / "raw/metrics.json")["classes"]} if analysis == "mri" else {}
    route = record.get("classification", {}).get("route_to_segmentation")
    if analysis in ("ct", "mri"):
        ontology_path = root / ("packages/EXMO_CT/configs/ontology.json" if analysis == "ct" else "packages/EXMO_MRI/configs/dataset/mri_thigh_29class_v001.json")
        ontology = read_json(ontology_path)["labels"]
    else:
        names = read_json(root / "packages/EXMO_XRAY/label_mapping.json")[route]["labels"]
        # Read the delivered literal palette without loading Torch/MONAI into the preview worker.
        tree = ast.parse((root / "packages/EXMO_XRAY/code/InferenceLOWEX_slicer_nrrd.py").read_text(encoding="utf-8"))
        colors = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "SLICER_SEGMENT_COLORS_BY_NAME" for target in node.targets))
        ontology = [{"id": int(cid), "name": name, "color": "#" + "".join(f"{round(float(c) * 255):02x}" for c in colors[name.lower()].split())} for cid, name in names.items()]
    permitted = {row["id"] for row in ontology}
    if not set(int(n) for n in np.unique(labels)).issubset(permitted):
        raise InputError("Mask에 ontology에 없는 class가 있습니다.")
    rows = []
    physical_unit = float(abs(np.linalg.det(np.array(image.GetDirection()).reshape(3, 3) @ np.diag(image.GetSpacing())))) / 1000
    pixel_area = float(np.prod(image.GetSpacing()[:2])) / 100
    for entry in ontology:
        cid = entry["id"]
        if not cid:
            continue
        name = entry.get("name", entry.get("display_name"))
        ident = canonical(name)
        color_entry = palette.get(ident, {})
        raw_metric = next((r for r in metric.get("classes", []) if r.get("class_id", r.get("label_id")) == cid), {}) if analysis != "xray" else metric.get("classes", {}).get(str(cid), {})
        count = int(counts[cid])
        expected_count = raw_metric.get("voxel_count", raw_metric.get("pixel_count"))
        if expected_count is not None and count != expected_count:
            raise InputError("Mask와 제공된 측정값의 voxel/pixel 수가 일치하지 않습니다.")
        value = count * (pixel_area if record.get("areaAvailable", True) else 1) if analysis == "xray" else count * physical_unit
        expected_value = raw_metric.get("volume_ml", raw_metric.get("volume_cm3", raw_metric.get("area_cm2")))
        if expected_value is not None and not np.isclose(value, expected_value, rtol=1e-5, atol=1e-5):
            raise InputError("Mask geometry와 측정 단위가 일치하지 않습니다.")
        rows.append({"label": cid, "id": ident, "name": name, "group": color_entry.get("group", "Bone" if name in ("femoral", "iliac", "Bone") else "All"),
                     "color": color_entry.get("color", entry.get("color", entry.get("color_hex", "#8c91b9"))), "count": count, "value": value,
                     **({"rawValue": raw_metrics[cid]["volume_ml"]} if analysis == "mri" else {}),
                     "fat": None if raw_metric.get("fat_range_voxel_fraction") is None else 100 * raw_metric["fat_range_voxel_fraction"],
                     "hu": (raw_metric.get("hu") or {}).get("mean"), "entropy": raw_metric.get("mean_entropy"),
                     "components": raw_metric.get("large_components_over_1ml"), "present": count > 0})
    mesh_path, mesh_bytes, side_path, lateral = None, None, None, None
    if analysis != "xray":
        side_folder, lateral = prepare_laterality(mask, rows, result, variant, analysis, image)
        mesh_path, mesh_bytes = side_folder / "surface.glb", lateral["meshBytes"]
        side_path = side_folder / "mask.nrrd"
    qc = read_json(result / "qc.json") if (result / "qc.json").exists() else {}
    postprocessing = {}
    if analysis == "mri":
        raw_total = sum(row["rawValue"] for row in rows)
        removed = sum(row["rawValue"] - row["value"] for row in rows)
        postprocessing = {"postprocessing": {"removedCm3": removed, "removedPercent": removed / raw_total * 100 if raw_total else 0,
                                              "changedVoxels": sum(raw_metrics[row["label"]]["voxel_count"] - row["count"] for row in rows)}}
    summary = {"id": message["id"], "inputId": record["id"], "analysis": analysis, "name": record["name"], "metadata": record["metadata"],
               "rows": rows, "unit": ("cm²" if record.get("areaAvailable", True) else "pixel") if analysis == "xray" else "cm³", "variant": variant, "route": route,
               "meshBytes": mesh_bytes, "laterality": lateral["info"] if lateral else None,
               "parts": lateral["parts"] if lateral else [],
               "qc": {**postprocessing, "flags": metric.get("qc_flags", []), "entropy": metric.get("foreground_mean_entropy"),
                      "ttaDisagreement": qc.get("identity_tta_disagreement_fraction"), "missing": qc.get("missing_active_class_ids", []),
                      "unexpected": qc.get("unexpected_class_ids", []), "tta": "identity + L/R flip" if analysis == "mri" else "5 folds + mirroring" if route and route.startswith("LAT") else "None"},
               "seconds": read_json(result / "desktop-complete.json")["seconds"], "createdAt": message["createdAt"]}
    publication = {"summary": summary, "record": record, "mask": str(mask_path), "sideMask": str(side_path) if side_path else None, "mesh": str(mesh_path) if mesh_bytes else None, "result": str(result)}
    write_json(result / ("desktop-result-" + variant + ".json"), publication)
    return publication


def prepare(message):
    record = message["record"]
    if not record.get("ready"):
        raise InputError("분석 조건을 충족하지 않는 영상입니다.")
    if record.get("confirmation") and not message.get("confirmed"):
        raise InputError("입력 단위/sequence 확인 후 실행하세요.")
    if record["analysis"] == "ct":
        source = Path(record["input"])
        if record.get("deferredValidation"):
            # Full validation and model-format conversion happen before inference.
            image = load_image(source)
            converted = source.parent / "validated-input.nii.gz"
            temporary = source.parent / "validated-input.tmp.nii.gz"
            sitk.WriteImage(image, str(temporary), True)
            temporary.replace(converted)
            source = converted
            record = {**record, "input": str(source), "deferredValidation": False}
        hu = source.parent / "hu_evidence.json"
        if not hu.exists():
            evidence = record.get("evidence") or "USER_CONFIRMED_HU"
            write_json(hu, {"evidence_id": evidence, "output_units": "HU", "scaling_stage": "nifti_reader_applied_once",
                            "source_sha256": digest(source), "status": "verified"})
            write_json(source.parent / "source_proof.json", {"source": evidence, "user_confirmation": bool(message.get("confirmed")),
                       "dicom": record.get("sourceProof"),
                       "note": "User confirmation is an input assertion, not independent HU validation."})
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-root", type=Path, required=True)
    parser.add_argument("--palette", type=Path, required=True)
    args = parser.parse_args()
    palette = {row["id"]: row for row in read_json(args.palette)}
    classification = args.engine_root / "packages/EXMO_XRAY/classification"
    sys.path.insert(0, str(classification))
    spec = importlib.util.spec_from_file_location("exmo_classifier", Path(__file__).with_name("classifier-worker.py"))
    classifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(classifier)
    classifier.engine.DEFAULT_DICOM_CACHE = classification / "models/dicom/training_features_4class_dicom_260711_corrected.npz"
    classifier.engine.DEFAULT_NRRD_CACHE = classification / "models/nrrd/training_features_4class_nrrd_260711.npz"
    classifier.pipeline = classifier.ViewClassificationPipeline(min_confidence=.4)
    for line in sys.stdin:
        message = {}
        try:
            message = json.loads(line)
            operation = message["operation"]
            if operation == "inspect":
                result = inspect(message, args.engine_root, classifier)
            elif operation == "preview":
                result = preview(message)
            elif operation == "prepare":
                result = prepare(message)
            elif operation == "finalize":
                clear_image_cache()
                result = finalize(message, args.engine_root, palette)
            elif operation == "clear":
                clear_image_cache()
                result = None
            else:
                raise InputError("지원하지 않는 작업입니다.")
            response = {"id": message["requestId"], "result": result}
        except InputError as error:
            response = {"id": message.get("requestId"), "error": str(error)}
        except Exception:
            import traceback
            traceback.print_exc(file=sys.stderr)
            response = {"id": message.get("requestId"), "error": "영상 처리 중 오류가 발생했습니다. 원본 geometry와 모델 입력 조건을 확인하세요."}
        print(json.dumps(response, ensure_ascii=False, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()

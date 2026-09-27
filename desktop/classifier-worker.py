"""Private desktop worker. JSON lines in/out; the supplied inference code is unchanged."""
from __future__ import annotations

import base64
import io
import json
import sys
import time
from pathlib import Path

import numpy as np
import nrrd
import pydicom
from PIL import Image

import classify_single_view as engine
from pipeline import ViewClassificationPipeline
from lower_extremity_classifier.features import normalize_image

MAX_PIXELS = 64_000_000


class InputError(ValueError):
    """User-facing messages authored here, never a decoder's exception text."""


def read_image(path):
    """Gate 2D X-ray inputs before invoking the bundle's original pixel reader."""
    kind = engine.infer_modality(path, "auto")
    warnings = []
    metadata = {"format": "DICOM" if kind == "dicom" else "NRRD"}
    if kind == "dicom":
        header = pydicom.dcmread(path, stop_before_pixels=True)
        modality = str(getattr(header, "Modality", "")).upper()
        if modality not in ("DX", "CR", "OT", ""):
            raise InputError("X-ray DICOM만 지원합니다. CT/MRI 등 다른 영상은 사용할 수 없습니다.")
        if modality in ("OT", ""):
            warnings.append("DICOM에 X-ray 촬영 종류가 명시되지 않아 확인이 필요합니다.")
        if int(getattr(header, "NumberOfFrames", 1)) != 1 or int(getattr(header, "SamplesPerPixel", 1)) != 1:
            raise InputError("단일 프레임 흑백 X-ray만 지원합니다.")
        count = int(getattr(header, "Rows", 0)) * int(getattr(header, "Columns", 0))
        metadata.update(seriesDescription=str(getattr(header, "SeriesDescription", ""))[:300],
                        studyDescription=str(getattr(header, "StudyDescription", ""))[:300])
    else:
        header = nrrd.read_header(str(path))
        # Detached headers could cause reads outside the user-selected file.
        if "data file" in header:
            raise InputError("영상 데이터가 한 파일에 포함된 NRRD만 지원합니다.")
        sizes = [int(value) for value in header["sizes"]]
        if len([size for size in sizes if size != 1]) != 2:
            raise InputError("2D X-ray NRRD만 지원합니다. 3D CT/MRI volume은 사용할 수 없습니다.")
        count = int(np.prod(sizes, dtype=object))
        warnings.append("NRRD의 촬영 종류는 자동 확인되지 않습니다. X-ray 영상인지 확인하세요.")
    if count <= 0 or count > MAX_PIXELS:
        raise InputError("지원하는 영상 크기를 벗어났습니다 (최대 6,400만 pixel).")
    image = (engine.read_dicom_image if kind == "dicom" else engine.read_nrrd_image)(path)
    if image.ndim != 2 or not np.isfinite(image).all() or np.ptp(image) <= 0:
        raise InputError("유효한 대비를 가진 2D 영상이 필요합니다.")
    metadata.update(width=int(image.shape[1]), height=int(image.shape[0]))
    return kind, image, metadata, warnings


def process(message, pipeline):
    path = Path(message["path"])
    started = time.perf_counter()
    kind, image, metadata, warnings = read_image(path)
    if message["operation"] == "preview":
        preview = Image.fromarray((normalize_image(image) * 255).astype(np.uint8))
        preview.thumbnail((1400, 1400), Image.Resampling.BILINEAR)
        buffer = io.BytesIO()
        preview.save(buffer, format="PNG")
        return {"image": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii"),
                "metadata": metadata, "warnings": warnings}
    if message["operation"] != "classify":
        raise InputError("지원하지 않는 작업입니다.")
    # Keep at most one modality model resident. Inference/features match pipeline.predict.
    if kind not in pipeline.models:
        pipeline.models.clear()
    pipeline.load(kind)
    model, thumb = pipeline.models[kind]
    prediction = model.predict_feature(path, engine.make_feature_from_image(image, thumb))
    view = engine.SEGMENTATION_VIEW_MAPPING[prediction.predicted_label]
    status = "ok" if prediction.confidence >= pipeline.min_confidence else "low_confidence"
    return {"predicted_label": prediction.predicted_label,
            "segmentation_view": view,
            "route_to_segmentation": view if status == "ok" else None,
            "confidence": prediction.confidence, "probabilities": prediction.probabilities,
            "status": status, "warnings": warnings, "metadata": metadata,
            "elapsed_ms": round((time.perf_counter() - started) * 1000)}


def main():
    root = Path(sys.argv[1]).resolve()
    engine.DEFAULT_DICOM_CACHE = root / "models/dicom/training_features_4class_dicom_260711_corrected.npz"
    engine.DEFAULT_NRRD_CACHE = root / "models/nrrd/training_features_4class_nrrd_260711.npz"
    pipeline = ViewClassificationPipeline(min_confidence=0.4)
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        message = {}
        try:
            message = json.loads(line)
            result = {"id": message["id"], "result": process(message, pipeline)}
        except InputError as exc:
            result = {"id": message.get("id"), "error": str(exc)}
        except Exception:
            # Never put patient paths, pixel data or decoder tracebacks in UI/logs.
            result = {"id": message.get("id"), "error": "영상을 읽거나 분류하지 못했습니다. 파일 형식과 압축 DICOM 지원 여부를 확인하세요."}
        print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()

"""Actual packaged MRI checkpoint/ROI GPU test, independent of desktop file access.

Synthetic input tests CUDA model execution only, not full image import/export.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sys
import time

sys.dont_write_bytecode = True
parser = argparse.ArgumentParser()
parser.add_argument("--engine-root", type=Path, required=True)
parser.add_argument("--report", type=Path, required=True)
args = parser.parse_args()
source = Path(__file__).resolve().parents[1] / "desktop/model-runner.py"
spec = importlib.util.spec_from_file_location("adapter", source)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
import torch
job = {"analysis": "mri", "device": "cuda:0"}
adapter.prepare_execution(torch, job)
runtime = adapter.load_module("mri_vendor", args.engine_root / "packages/EXMO_MRI/run_inference.py")
if os.name == "nt":
    # Match the desktop's binary-read adaptation; retain all strict hash checks.
    from thigh_muscle_seg.core import structured_input
    structured_input.os = SimpleNamespace(**vars(os))
    structured_input.os.O_RDONLY |= os.O_BINARY
from thigh_muscle_seg.training.checkpoint import load_model_weights_strict
config, recipe, ontology, model_spec, contract = runtime.setup(runtime.ROOT, runtime.CONFIG)
runtime.set_determinism(config["training"]["seed"])
torch.set_num_threads(4)
model = runtime.attach_model_contract(runtime.build_model(model_spec, ontology), contract)
manifest_sha = runtime.sha256_file(runtime.WEIGHTS.with_name(runtime.WEIGHTS.name + ".manifest.json"))
loaded = load_model_weights_strict(runtime.WEIGHTS, contract, model,
    expected_payload_sha256=runtime.WEIGHT_SHA, expected_manifest_sha256=manifest_sha)
roi = tuple(config["inference"]["roi_size_zyx"])
predictor = runtime.TorchModelPredictor("full6_annotation", model,
    runtime.TorchPredictionStrategy(mode="sliding_window", device="cuda:0", roi_size_zyx=roi,
        overlap=config["inference"]["overlap"], sw_batch_size=1, blend_mode="gaussian"))
started = time.monotonic()
logits = predictor.predict_logits(runtime.np.zeros(roi, dtype=runtime.np.float32))
torch.cuda.synchronize()
assert runtime.np.isfinite(logits).all()
assert logits.shape[0] == 29
peak = torch.cuda.max_memory_allocated()
assert peak > 0
report = {"passed": True, "scope": "actual MRI checkpoint, synthetic single ROI, GPU forward only; not full image IO",
    "device": "cuda:0", "gpu": torch.cuda.get_device_name(0), "torch": torch.__version__,
    "model_sha256": loaded.payload_sha256, "precision": "float32", "roi": roi,
    "output_shape": list(logits.shape), "peak_gpu_memory_bytes": peak, "seconds": time.monotonic() - started}
args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report), flush=True)

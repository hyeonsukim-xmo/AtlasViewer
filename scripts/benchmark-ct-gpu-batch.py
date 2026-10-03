"""Benchmark unchanged CT checkpoint FP32 predictor batch sizes on synthetic ROIs."""
import argparse
import importlib.util
import json
from pathlib import Path
import statistics
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
root = args.engine_root / "packages/EXMO_CT"
torch = adapter.ct_torch(root, "cuda:0")
torch.set_num_threads(4)
torch.manual_seed(123)
torch.use_deterministic_algorithms(True)
torch.backends.cudnn.benchmark = False
torch.backends.cuda.matmul.allow_tf32 = False
torch.backends.cudnn.allow_tf32 = False
runtime = adapter.load_module("ct_vendor", root / "run.py")
model, model_hash = runtime.model_for(adapter.read(root / "configs/inference.json"), "cuda:0")
patches = torch.rand((4, 1, 96, 96, 96), device="cuda:0")
results = []
reference = None
with torch.inference_mode():
    for batch in (1, 2, 4):
        try:
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
            times = []
            for iteration in range(4):
                torch.cuda.synchronize()
                start = time.perf_counter()
                output = torch.cat([model(part) for part in patches.split(batch)], dim=0)
                torch.cuda.synchronize()
                elapsed = time.perf_counter() - start
                if iteration:
                    times.append(elapsed)
            value = output.cpu()
            if reference is None:
                reference = value
            item = {"batch": batch, "median_seconds_for_four_patches": statistics.median(times),
                "peak_gpu_memory_bytes": torch.cuda.max_memory_allocated(),
                "max_absolute_logit_difference": float((reference - value).abs().max()),
                "argmax_different_voxels": int((reference.argmax(1) != value.argmax(1)).sum())}
            del output, value
        except torch.cuda.OutOfMemoryError:
            item = {"batch": batch, "error": "CUDA out of memory"}
            torch.cuda.empty_cache()
        results.append(item)
        print(json.dumps(item), flush=True)
args.report.write_text(json.dumps({"gpu": torch.cuda.get_device_name(0), "model_sha256": model_hash,
    "precision": "float32", "tf32": False, "scope": "synthetic predictor throughput, not end-to-end or accuracy", "results": results}, indent=2), encoding="utf-8")

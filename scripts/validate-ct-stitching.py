"""Check CT memory routing and compare host vs resident input with GPU stitching.

Run with the CT environment's Python. --real performs one warmup and three timed
runs per condition on the delivered first CT sample; masks never leave the PC.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import statistics
import sys
import time
import weakref
from types import SimpleNamespace as NS
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("runner", ROOT / "desktop/model-runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def check_contract():
    class OOM(RuntimeError): pass
    uploads, retries = [], []
    class Input:
        shape = (1, 1, 197, 197, 277)
        def __init__(self, device="cpu"): self.device = device
        def to(self, device):
            uploads.append(device)
            return Input(device)
    class Logits:
        transfers = 0
        def cpu(self):
            self.transfers += 1
            return self
    free = [8 * 1024 ** 3]
    cuda = NS(mem_get_info=lambda _: (free[0], 8 * 1024 ** 3), memory_reserved=lambda _: 0,
              memory_allocated=lambda _: 0, synchronize=lambda _: None, empty_cache=lambda: None)
    fake_torch = NS(cuda=cuda, OutOfMemoryError=OOM)
    options = dict(sw_device="cuda:0", device="cpu", overlap=.8, mode="gaussian",
                   sigma_scale=.2, padding_mode="reflect", progress=False)
    tensor = Input()
    with patch.dict(sys.modules, {"torch": fake_torch}), patch.object(runner, "emit", lambda *a, **kw: None):
        for device in ("cpu", "cuda:0"):
            logits, execution, calls = Logits(), {}, []
            def infer(prepared, *args, **kwargs):
                calls.append((prepared.device, args, kwargs))
                return logits
            selected = {**options, "sw_device": device}
            assert runner.ct_sliding_window(infer, tensor, (96,)*3, 4, "model", execution=execution, **selected) is logits
            assert calls == [(device, ((96,)*3, 4, "model"), {**selected, "device": device})]
            assert logits.transfers == 1 and execution["input_resident"] == device
        assert uploads == ["cuda:0"], "Exactly one input upload per inference"
        assert runner.ct_gpu_bytes((1,1,433,433,299), (96,)*3) > free[0]
        assert runner.ct_gpu_bytes((1,1,1,64,64), (96,)*3) == 96**3 * 36 * 4 + 3 * 1024**3
        free[0] = 0
        calls, execution = [], {}
        runner.ct_sliding_window(infer, tensor, (96,)*3, 4, "model", execution=execution, **options)
        assert calls[0][0] == "cpu" and calls[0][2]["sw_device"] == "cuda:0"
        assert execution["accumulation_reason"] == "gpu_memory_budget" and uploads == ["cuda:0"]
        free[0] = 8 * 1024**3
        calls, execution, failed_tensor = [], {}, []
        def interrupted(prepared, *args, **kwargs):
            calls.append(kwargs["device"])
            if len(calls) == 1:
                failed_tensor.append(weakref.ref(prepared))
                raise OOM("simulated GPU allocation failure")
            assert failed_tensor[0]() is None, "Failed CUDA input must be released before retry"
            assert prepared is tensor and kwargs == options
            return Logits()
        runner.ct_sliding_window(interrupted, tensor, (96,)*3, 4, "model", execution=execution,
                                 retry=lambda: retries.append(True), **options)
        assert calls == ["cuda:0", "cpu"] and retries == [True]
        assert execution["accumulation_reason"] == "cuda_oom"
        for failure in (RuntimeError("not OOM"), OOM("both attempts fail")):
            calls = []
            def fail(*args, **kwargs):
                calls.append(kwargs["device"])
                raise failure
            try:
                runner.ct_sliding_window(fail, tensor, (96,)*3, 4, "model", **options)
            except RuntimeError as error:
                assert error is failure
            else:
                raise AssertionError("Unrecoverable errors must propagate")
            assert len(calls) == (2 if isinstance(failure, OOM) else 1)
    print("PASS: memory gate, one-time upload, unchanged recipe, OOM cleanup/retry and failure propagation", flush=True)


def real_check(engine, output):
    if output.exists():
        raise FileExistsError(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    package = engine / "packages/EXMO_CT"
    torch = runner.ct_torch(package, "cuda:0")
    import numpy as np
    import SimpleITK as sitk
    runtime = runner.load_module("ct_stitch_validation", package / "run.py")
    cfg = runner.read(package / "configs/inference.json")
    case = runner.read(package / "samples/manifest.json")["cases"][0]
    source = package / case["input"]
    assert runtime.sha256_file(source) == case["input_sha256"]
    torch.set_num_threads(4)
    sitk.ProcessObject.SetGlobalDefaultNumberOfThreads(4)
    torch.manual_seed(cfg["seed"])
    np.random.seed(cfg["seed"])
    torch.use_deterministic_algorithms(True)
    torch.backends.cudnn.benchmark = False
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    model, model_hash = runtime.model_for(cfg, "cuda:0")
    tensor, _ = runtime.preprocess(source, cfg)
    sw = cfg["sliding_window"]
    assert tuple(sw["roi_size"]) == (96, 96, 96) and sw["small_overlap"] == .8
    assert np.prod(tensor.shape[2:]) <= sw["size_branch_threshold_voxels"]
    # Match Desktop's existing predictor microbatch and concatenation exactly.
    def predictor(patches):
        return torch.cat([model(patch) for patch in patches.split(4)], dim=0)
    report = {"gpu": torch.cuda.get_device_name(0), "torch": torch.__version__,
              "source_sha256": case["input_sha256"], "model_sha256": model_hash,
              "adapter_sha256": runtime.sha256_file(ROOT / "desktop/model-runner.py"),
              "recipe": cfg, "input_shape": list(tensor.shape), "warmups_per_condition": 1,
              "timed_runs_per_condition": 3, "includes_final_cpu_transfer": True,
              "conditions": {}, "passed": False}
    baseline = None
    with torch.inference_mode():
        for condition in ("host_input", "resident_input"):
            trials = []
            for repetition in range(4):
                torch.cuda.empty_cache()
                torch.cuda.synchronize()
                torch.cuda.reset_peak_memory_stats()
                runner._context.timing = {"seconds": {}, "stack": []}
                execution = {}
                start = time.perf_counter()
                args = (tensor, tuple(sw["roi_size"]), sw["small_batch_size"], predictor)
                kwargs = dict(overlap=sw["small_overlap"], mode=sw["mode"], sigma_scale=sw["sigma_scale"],
                              padding_mode=sw["padding_mode"], sw_device="cuda:0", device="cuda:0", progress=False)
                logits = (runtime.sliding_window_inference(*args, **kwargs).cpu() if condition == "host_input" else
                          runner.ct_sliding_window(runtime.sliding_window_inference, *args, execution=execution, **kwargs))
                torch.cuda.synchronize()
                elapsed = time.perf_counter() - start
                peak = torch.cuda.max_memory_allocated()
                if condition == "resident_input":
                    assert execution["accumulation"] == execution["input_resident"] == "cuda:0"
                assert logits.device.type == "cpu" and logits.dtype == torch.float32
                # Hash outside timing, without allocating another full logits byte array.
                digest = hashlib.sha256(memoryview(logits.numpy()).cast("B")).hexdigest()
                del logits
                baseline = baseline or digest
                assert digest == baseline, "Host/resident input or repeated logits changed"
                trial = {"seconds": elapsed, "peak_allocated_bytes": peak, "logits_sha256": digest,
                         "input_upload_seconds": runner._context.timing["seconds"].get("input_upload", 0),
                         "execution": execution}
                print(json.dumps({"condition": condition, "warmup": repetition == 0, **trial}), flush=True)
                if repetition:
                    trials.append(trial)
            report["conditions"][condition] = {"trials": trials,
                "median_seconds": statistics.median(t["seconds"] for t in trials),
                "max_allocated_bytes": max(t["peak_allocated_bytes"] for t in trials)}
            output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    report["passed"] = True
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("PASS: warmup + 3 repeated CT host/resident input logits bitwise identical", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--real", action="store_true")
    parser.add_argument("--engine-root", type=Path, default=ROOT / "work/modality-integration")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.real and args.output is None:
        parser.error("--real requires a new --output report path")
    check_contract()
    if args.real:
        real_check(args.engine_root.resolve(), args.output.resolve())

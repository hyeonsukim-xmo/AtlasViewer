"""Check pinned imports and actual CPU/CUDA execution without touching application data."""
from __future__ import annotations

import argparse
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
IMPORTS = {
    "ct": ("numpy", "SimpleITK", "nrrd", "nibabel", "pydicom", "scipy", "PIL", "monai", "trimesh", "skimage", "fast_simplification", "einops"),
    "mri": ("numpy", "SimpleITK", "nrrd", "monai", "safetensors", "jsonschema"),
    "ap": ("numpy", "nrrd", "monai", "matplotlib", "pydicom"),
    "lat": ("numpy", "SimpleITK", "nibabel", "nrrd", "nnunetv2.inference.predict_from_raw_data", "torchvision"),
}


def probe(name, device, engine_root):
    if struct.calcsize("P") != 8 or sys.version_info[:3] != (3, 12, 8):
        raise RuntimeError("The tested runtime is CPython 3.12.8 x64")
    versions = {}
    for line in (ROOT/f"desktop/requirements-{name}.txt").read_text(encoding="utf8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        package, expected = line.split("==")
        actual = importlib.metadata.version(package)
        # PEP 440 == without a local suffix accepts the wheel's CUDA suffix.
        if (actual if "+" in expected else actual.split("+")[0]) != expected:
            raise RuntimeError(f"{package}: expected {expected}, found {actual}")
        versions[package] = actual
    if name == "ct" and device != "cpu":
        spec = importlib.util.spec_from_file_location("desktop_runner", ROOT / "desktop/model-runner.py")
        adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(adapter)
        adapter.ct_torch(engine_root / "packages/EXMO_CT", "cuda:0")
    for package in IMPORTS[name]:
        importlib.import_module(package)
    import torch
    torch.set_num_threads(2)
    target = "cpu" if device == "cpu" else "cuda:0"
    if target != "cpu" and not torch.cuda.is_available():
        raise RuntimeError(f"{name}: CUDA is unavailable; check the NVIDIA driver for Torch {torch.__version__}")
    with torch.inference_mode():
        conv = torch.nn.Conv3d(1, 1, 3).to(target)
        result = conv(torch.ones((1, 1, 8, 8, 8), device=target))
        if not bool(torch.isfinite(result).all()):
            raise RuntimeError("Nonfinite tensor execution result")
        if target != "cpu":
            torch.cuda.synchronize()
    return {"environment": name, "python": platform.python_version(), "device": target,
            "gpu": torch.cuda.get_device_name(0) if target != "cpu" else None,
            "cudaRuntime": torch.version.cuda, "runtimeTorch": torch.__version__, "versions": versions, "passed": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine-root", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--probe", choices=tuple(IMPORTS))
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.probe:
        print(json.dumps(probe(args.probe, args.device, args.engine_root)))
        return
    root = args.engine_root.resolve()
    expected = json.loads((root/"verified-packages.json").read_text(encoding="utf8"))
    from importlib.util import spec_from_file_location, module_from_spec
    spec = spec_from_file_location("delivery_integrity", ROOT/"scripts/prepare-imaging-packages.py")
    integrity = module_from_spec(spec)
    spec.loader.exec_module(integrity)
    if expected != integrity.ARCHIVES:
        raise RuntimeError("The installed packages do not match the supported delivery")
    report = {"schema": 1, "deviceRequested": args.device, "environments": [], "passed": True,
              "scope": "Pinned dependencies, imports and tensor execution; not real-volume inference or clinical accuracy"}
    for name in IMPORTS:
        print(f"Checking {name} runtime...", flush=True)
        try:
            process = subprocess.run([str(root/f"envs/{name}/Scripts/python.exe"), "-X", "utf8", str(Path(__file__).resolve()),
                                      "--engine-root", str(root), "--device", args.device, "--probe", name],
                                     capture_output=True, text=True, encoding="utf8", timeout=180,
                                     env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1"})
            if process.returncode:
                raise RuntimeError(process.stderr[-4000:] or process.stdout[-4000:])
            entry = json.loads(process.stdout.splitlines()[-1])
        except Exception as error:
            entry = {"environment": name, "passed": False, "error": str(error)}
            report["passed"] = False
        report["environments"].append(entry)
        print(json.dumps({k: v for k, v in entry.items() if k != "versions"}), flush=True)
    destination = args.report or root/"runtime-check.json"
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf8")
    print(f"Runtime report: {destination}")
    if not report["passed"]:
        sys.exit(1)


if __name__ == "__main__":
    main()

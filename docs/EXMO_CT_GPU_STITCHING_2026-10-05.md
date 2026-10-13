# CT GPU stitching — 2026-10-05

This records the first GPU-stitching change and its measurements. The subsequent
[input residency change](EXMO_CT_INPUT_RESIDENCY_2026-10-05.md) adds memory routing
and an explicit CPU-stitch retry. Its current focused checker compares input
residency; the CPU/GPU stitching measurements below remain historical evidence.

## Change

Desktop CT now uses the selected inference device for MONAI sliding-window
accumulation. With CUDA selected, the assembled logits move to CPU once before
the existing CPU softmax and physical native-grid inverse. Explicit CPU inference
still accumulates on CPU. The vendor package and checkpoint are not edited.

Patch size 96³, overlap branches (small 80%, large 50%), batch/microbatch,
Gaussian weighting, FP32, disabled TF32/AMP, no TTA, native inverse and PP_NONE
remain unchanged. Neither 128³ nor a lower overlap was adopted.
`desktop-complete.json` records `execution.accumulation`. CUDA OOM remains a
reported failure; no hidden retry changes device, overlap or precision.
The additional accumulation memory means that passing the tested input does not
establish that every larger input fits an 8 GB GPU.

## External evidence and source availability

The model developer reported five CT cases on RTX 4090 24 GB, one warmup and
three measured repetitions per condition. CPU vs GPU stitching at 80% had
identical logits/masks and zero volume difference. Lowering overlap to 50%
changed 5.1–12.8% of foreground voxels and up to +51.3% class volume, without GT
to determine accuracy. Their 128³ strict checkpoint load failed on positional
embedding dimensions. These are supplied findings, not local 3050 measurements.

At implementation time `U:\CT_inference_benchmark_v001` contained `README.md`,
`audit.py` and `.venv`; the cited full report, CSV and `benchmark.py` were absent.
The README included the GPU-stitch/CPU-transfer code and recipe. Integration
follows that code and is checked locally instead of claiming the missing files
were inspected.

## Desktop end-to-end check

Local RTX 3050 8 GB, Ryzen 5600X, Windows, Torch 2.7.0+cu126 and MONAI 1.3.2.
One delivered CT input, one fresh-process execution per condition. These are
diagnostic observations, not repetition medians or a five-case local validation.

| Stage / resource | CPU stitching | GPU stitching |
|---|---:|---:|
| Inference + stitching, including final CPU transfer | 107.33 s | 83.19 s |
| Peak Torch allocated GPU memory | 2.27 GiB | 3.63 GiB |
| Measurements / Overlay available | 317.33 s | 216.84 s |
| Whole batch including 3D | 334.92 s | 228.04 s |

Input/model/recipe/runtime identities matched. Native mask, class measurements,
HU/fat measurements, laterality, QC and axial/coronal/sagittal Overlay signatures
were exactly equal. Both runs produced a valid GLB. No OOM occurred.

Other stages varied too: startup was 71.35 vs 30.90 seconds and native restoration
59.89 vs 42.59 seconds despite no changes to either path. A separate file-copy
process was also present. Therefore the total-time reduction must not be
attributed solely to stitching, or treated as a controlled speedup estimate.

Private local evidence, excluded from Git:

- `outputs/performance/ct-cpu-stitch-20261005/report.json`
- `outputs/performance/ct-gpu-stitch-20261005/report.json`
- `outputs/performance/ct-gpu-stitch-20261005/parity.json`

## Repeatable focused check

`scripts/validate-ct-stitching.py` exercises the production wrapper against the
original MONAI CPU-stitch call. Model/input stay loaded, Desktop's predictor
microbatch/concatenation are reproduced, and each condition runs one full warmup
plus three measured repetitions. Final CPU transfer is included; full-logits
hashing is outside the timed interval. Cache is emptied and peak allocation reset
before each run. Every logits hash must match across conditions and repetitions.

The local first CT sample passed all eight full inferences (one warmup and three
timed runs per condition), with bitwise-identical logits throughout:

| Condition | Three measured runs | Median | Peak allocated GPU memory |
|---|---|---:|---:|
| 80% + CPU stitching | 97.10 / 92.27 / 101.46 s | 97.10 s | 2.27 GiB |
| 80% + GPU stitching | 67.60 / 65.95 / 68.92 s | 67.60 s | 3.63 GiB |

Observed median reduction: 30.4% (1.44× throughput for this inference interval).
This is a same-input local comparison, not the 4090 five-case measurement and
not an estimate of the speedup for every scan. No OOM occurred. The focused
report is `outputs/performance/ct-stitch-focused-20261005/report.json` (private).
Native output parity is checked by the separate full Desktop executions above.

The lightweight device/recipe/error-propagation check, performance-checker
regression checks, Python syntax and `git diff --check` also passed.

See [performance commands](DESKTOP_PERFORMANCE.md) to rerun on another GPU.

# CT input residency and memory handling — 2026-10-05

## Reviewed source and scope

Reviewed `U:\CT_cost_review_v002`: CONCLUSION, RUNBOOK, VERIFICATION, inference
and inverse candidate implementations, and the comparison table. The supplied
4090 results support exact input residency in seven cases. They are not 3050
measurements. AMP, batch changes, GPU interpolation and new models were not adopted.

## Desktop change

- Keep input on GPU for the complete sliding-window inference when memory allows.
  Upload once, preserve FP32 and the existing predictor/microbatch, then transfer
  assembled logits to CPU once for the original softmax/native inverse.
- Estimate padded model-grid memory for 33 FP32 output channels, a count map,
  input/padding buffers, plus a conservative 3 GiB current-UNETR workspace allowance.
  Compare with driver free memory plus reusable Torch cache. The 64M-voxel recipe
  branch is not used as a VRAM safety threshold.
- If the estimate does not fit, retain CPU input and CPU stitching with GPU
  forward. If a GPU attempt nevertheless raises CUDA OOM, leave the exception
  scope to release tensors, empty unused cache, reset progress and retry CPU
  stitching once. Never reduce overlap/batch or enable AMP automatically.
  Other errors and failure of the retry propagate as failed jobs.
- Record actual accumulation/input devices, reason and memory estimates in the
  private execution record. Show compute devices and CPU-stitch reason in QC.
  Measure one-time input upload separately as `input_upload` in QC/performance
  reports; exclude it from the enclosing exclusive inference timer.

The memory allowance is deliberately conservative and is not a certified upper
bound. Concurrent allocations/fragmentation can still cause OOM; even CPU
stitching needs GPU forward workspace and sufficient host RAM.

## Why the supplied CPU inverse was not copied wholesale

Desktop already reads resampled SimpleITK results via a borrowed view while
retaining its owner, reuses prepared source-channel images, and restores native
probabilities in bounded slabs (at most 256 MiB, at most 16 slices). Normalization
and first-index argmax run on native probabilities. No full native 33-channel
probability array is retained.

The supplied CPU_OPTIMIZED code also removes a SimpleITK copy and blocks array
operations, but still allocates the full native 33-channel array. Its EXT_LONG
example needs 33.61 GiB for that array alone. Replacing the existing Desktop
implementation would reintroduce this allocation. Therefore the current CPU
inverse is unchanged; no additional CPU restoration speedup is claimed.

## Local validation method

`scripts/validate-ct-stitching.py` checks device/recipe preservation, one upload,
small-input padding, the 433×433×299 model-grid memory rejection, memory-budget
selection, cleanup before OOM retry, progress restart callback and terminal
errors. Low-memory/OOM branches are injected contract tests, not a claim of a
real 56M-voxel inference on this 3050.

The real A/B uses the first delivered CT case, RTX 3050 8 GB, one loaded model,
one full warmup and three timed repetitions per condition. Both use GPU
stitching; the candidate additionally keeps input resident. Timings include each
run's input upload and final logits CPU transfer; hashing is outside timing.
All repeats must have bitwise-identical logits. Full Desktop native output,
measurements, QC and three-view Overlay are compared separately with the saved
GPU-stitch result. Other modalities are not rerun.

## RTX 3050 result

Local CT case `EXMO_CASE_001`, RTX 3050 8 GB, Torch 2.7.0+cu126:

| Input location (both GPU stitching) | Three timed runs, seconds | Median | Peak allocated |
|---|---|---:|---:|
| CPU, existing | 63.658 / 63.820 / 63.870 | 63.820 s | 3.631 GiB |
| GPU, resident | 63.644 / 64.302 / 63.500 | 63.644 s | 3.672 GiB |

The 0.176 s (0.28%) difference does **not** establish a meaningful speedup on
this 3050. The 4090 improvement did not reproduce at a comparable magnitude.
Peak allocation increased by 42 MiB. All warmups and timed outputs were bitwise
identical, SHA-256
`8939c81c3e8921c43a2d35deb68eb2a9059302520924f708166fa8ae2a1a8de2`.

Evidence: `outputs/performance/ct-resident-input-20261005/report.json` (private,
Git-ignored). An initial execution produced no timed result and was stopped;
it contributes no measurements. The completed execution used diagnostic stack
dumps every 90 seconds; those messages were not test failures. Input-upload
subtimings were 0 / 0 / 0.016 s at the current timer resolution.

The installed recipe remains unchanged, including its pre-existing >64M-voxel
overlap/batch branch. This work does not validate that branch's lower overlap;
the tested case uses overlap 0.8, batch 4 and 96³ patches.

### Full Desktop verification (2026-10-06 KST)

One fresh-process CT run completed successfully. Input, model and recipe hashes
matched the saved GPU-stitch run. Native mask payload, related masks,
measurements, QC and axial/coronal/sagittal Overlay hashes all matched exactly.
Measurements/Overlay were published while 3D was pending; the final mesh was
17,579,684 bytes. Published compute metadata confirms GPU inference, GPU
stitching and GPU-resident input.

| Stage / endpoint | Previous saved single run | New single run |
|---|---:|---:|
| Model startup / communication | 30.90 s | 23.33 s |
| Model loading | 3.63 s | 0.89 s |
| Preprocessing | 7.81 s | 2.64 s |
| Input GPU upload | included in inference | 0.015 s |
| Inference | 83.19 s | 98.05 s |
| Native restoration | 42.59 s | 26.13 s |
| Postprocessing | 0.016 s | 0.015 s |
| Model measurements | 9.84 s | 3.89 s |
| Save / copies | 15.31 s | 20.73 s |
| Verification | 7.91 s | 4.69 s |
| Other model work (residual) | 5.59 s | 45.17 s |
| Desktop result preparation | 10.05 s | 6.33 s |
| 3D generation | 10.05 s | 8.31 s |
| Results ready (endpoint) | 216.84 s | 231.89 s |
| Batch complete (endpoint) | 228.04 s | 241.22 s |

This single full-pipeline run was **slower**, not an application speedup. Large
changes also occurred in untouched phases. The cause of residual model work
(45.17 s) is not established; do not attribute the native-restoration decrease
or total increase to input residency. Use the controlled warm A/B above for the
isolated residency comparison. Endpoint totals overlap the stage rows.

Evidence: `outputs/performance/ct-resident-desktop-20261006/report.json` and
`parity.json`; saved baseline `ct-gpu-stitch-20261005/report.json`.

Contract tests, synthetic early-publication/mesh/cache checks, performance-checker
regressions, TypeScript checks, localization checks and Desktop build passed.
This validates the tested engineering output; no new clinical-accuracy claim
or multi-case 3050 equivalence claim is made.

### Follow-up: locating the residual delay

Existing `engine-private.log` event timestamps narrow the residual increase;
no new inference was run for this inspection. Time from `result_export_start`
(end of native inverse) to the first `result_save` was **0.391 s before, 42.515 s
after**. This interval contains probability release, postprocessing and its
equality check, and provenance construction (including ontology/code hashes
and package-version lookup). It is before the timed save call. Postprocessing
itself was only 0.015 s, and `case_complete` to `complete` was 0.219 s, so the
42-second gap is not the final garbage collection or 3D generation.

The specific slow call inside that interval was not instrumented in these
saved runs. File-system contention, metadata lookup, memory release and other
runtime causes remain unproven. This locates the main residual delay without
asserting that input residency caused it. Inference independently rose by
14.859 s in the fresh-process run; the controlled warm residency comparison
still showed only a 0.176 s median difference.

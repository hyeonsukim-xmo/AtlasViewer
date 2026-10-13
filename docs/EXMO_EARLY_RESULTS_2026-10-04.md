# Desktop incremental results and timing

Measurements, native-mask validation, laterality and the Overlay source are now
published before mesh generation. `finalize(deferMesh: true)` does not invoke
meshing; the existing finalizer process generates the surface in a queued request.
No new inference jobs, precision changes, TTA changes or mask exports are added.

The result is immediately listed and can be opened while the batch is running.
`meshState` is pending / ready / empty / failed / interrupted. The open result
refreshes pending states and enables 3D when all compared meshes are ready.
Cancellation or a mesh failure preserves the first publication. A restart marks
unfinished meshes interrupted; Retry 3D reuses the saved measurements. A completed
mesh from an older variant cannot replace a newer selected variant. Mesh output
and result publication use temporary files followed by replacement.

Geometry uses the existing single result-preparation lane, with the existing
batch memory budget. It can overlap inference, but does not run concurrently
with another finalizer operation. CPU-only inference admission remains serial.
The batch stays running until its mesh queue drains; successfully published
measurements are already available during that interval.

## Timing

New results expose timings in QC. Old results without timings show no invented
measurements. Model stages use per-job, exclusive monotonic wall time: loading,
preprocessing, inference, native restore, postprocessing, measurements, export
and other work. Nested measurement calls are subtracted from export time.
LAT's vendor prediction combines inference and resampling, so it is explicitly
reported as a combined stage. Uninstrumented work stays in Other, never zero.

Desktop also records input preparation (including its worker queue), memory/GPU/
CPU/result-lane waits, process startup/communication, time to initial results,
mesh queue wait and mesh generation. Initial-result time starts when a case
enters the batch executor, not when the whole batch was submitted. Batch elapsed
time is measured separately and saved to the private imaging store as
`batch-<id>.timings.json`. Overlapping case durations must not be added to infer
batch duration. First-run import/startup time is not GPU inference time.

## Checks and observed sample

- `node scripts/validate-early-results.cjs`: early publication / Overlay, failure,
  cancellation, retry, restart recovery, stale variant rejection.
- CT Python environment: `scripts/validate-early-results.py` and `--sample`:
  real mesh generation, cached laterality, unchanged measurements / Overlay /
  raw artifacts, exclusive timing arithmetic. `--sample` uses the existing local
  MRI validation result and copies it to a temporary directory.
- Actual MRI sample_01 GPU inference through the desktop dispatcher: initial
  results available while mesh is pending; Overlay request succeeds; 3D completes;
  Raw and PP500 are voxel-exact against the prior local inference.
- Type checking, web/Desktop builds, atlas interactions, language coverage,
  geometry/Overlay/postprocessing checks, pipeline/worker tests passed. The real
  Electron suite passed slice scrolling, 3-case comparison, paired selection and
  rotation, variant changes, AP cancellation/retry/inference and web isolation.
  Its old compact-row limit and analysis button label were updated to the already
  shipped readable spacing and counted batch button; no application styling was
  changed for this task.

That single RTX 3050 run measured 3.58 s inference, 14.45 s native restoration,
47.45 s export/verification, 8.25 s model measurements, and 3.75 s mesh generation.
Cold engine startup/communication was about 40.08 s. These are one-run diagnostic
observations, not benchmark medians or expected timings for another machine.
Reports remain local under `outputs/early-results-check/`.

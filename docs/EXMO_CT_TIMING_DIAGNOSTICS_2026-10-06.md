# CT timing diagnostics — 2026-10-06

## Problem and changes

The previous single Desktop run took 241.22 seconds, versus 228.04 in an older
run. Its residual model time rose from 5.59 to 45.17 seconds. Existing events
locate a 42.515-second interval between native restoration and the first save,
but cannot retrospectively identify the slow call inside it.

Desktop now records exclusive timings for logits checks, softmax, probability
validation, label equality, ontology/code hashes, environment lookup, metadata
writes, payload hashing and garbage collection. Private operation start/end
events include wall time, current-thread CPU time and success/failure. Failed
operations retain their timing and rethrow the original error. Environment
events additionally name the queried package or platform function, without
logging input data, masks, local variables or patient identifiers.

Initial Torch, NumPy, SimpleITK, MONAI and nnU-Net imports also emit job-bound
start/end events. The performance report shows initialization details in a
separate table: they are included in engine startup, not additional model time.
Calls and import order are preserved. No numeric settings or model weights
were changed; instrumentation is job-local and does not patch shared libraries.

## Diagnostic run

`outputs/performance/ct-detail-20261006/report.json` completed one real CT run:

| Operation | Seconds |
|---|---:|
| Inference | 64.25 |
| Native restoration | 27.80 |
| Logits finite check | 1.19 |
| Softmax | 0.58 |
| Probability validation | 1.00 |
| Code hashes | 0.11 |
| Environment lookup | 0.16 |
| JSON/CSV metadata | 0.05 |
| Cleanup | 0.14 |
| Residual model work | 0.58 |
| Engine startup/communication | 44.61 |
| Results ready | 172.63 |
| Batch complete | 182.11 |

The 42-second pre-save delay did **not** recur. The engine startup delay was
still substantial, so imports received their own timers before confirmation
runs. An import-only cProfile run took 14.81 seconds, including 4.81 seconds
for Torch/CUDA availability and 9.72 seconds for MONAI. Python source
compilation accounted for 5.96 seconds of self time in this profile. These are
diagnostic observations, not an explanation of the earlier 44.61-second startup
or the historical 42.515-second pre-save interval.

Python 3.12's platform queries can use WMI, but WMI has **not** been established
as the historical cause. Platform/package queries remain separately observable;
they were not bypassed, cached or replaced on speculation.

The diagnostic native mask, related masks, measurements, QC and all three
Overlay hashes matched the previous saved run. The raw reports, per-job logs
and import profile are private under `outputs/performance/` and the report's
local storage path; do not commit them or mask artifacts.

## Verification and use

Two confirmation runs with final instrumentation are recorded in
`outputs/performance/ct-detail-confirm-20261006/report.json` and `parity.json`:

| Stage / endpoint | Run 1 | Run 2 |
|---|---:|---:|
| Engine startup / communication | 13.53 s | 13.29 s |
| Torch import (included in startup) | 4.43 s | 4.36 s |
| MONAI import (included in startup) | 8.89 s | 8.69 s |
| Inference | 63.89 s | 68.34 s |
| Native restoration | 36.00 s | 30.50 s |
| Code hashes | 0.094 s | 0.063 s |
| Environment lookup | 0.031 s | 0.031 s |
| Remaining other model work | 0.327 s | 0.422 s |
| Results ready | 147.55 s | 147.52 s |
| 3D-inclusive batch completion | 157.14 s | 158.09 s |

Both runs match the saved pre-instrumentation native masks, related masks,
measurements, QC and axial/coronal/sagittal Overlay signatures. Both published
results before 3D and completed mesh generation. No 42-second pre-save delay
occurred in any of the three diagnostic/confirmation runs. These observations
do not establish its historical cause or prove its recurrence is fixed.

Existing checks now also cover successful/failed operation events, exception
propagation, closed timing stacks and startup-table rendering. Synthetic early
publication/cache/mesh checks, TypeScript, English localization and Desktop
build passed. MRI/X-ray inference was not rerun.

Use the existing checker for subsequent measurements:

```powershell
node scripts/performance-desktop.cjs --cases ct --repeats 3 --output outputs/performance/ct-next
```

Read `report.json` for exclusive stage totals and `startupOperations`, and the
trial's `engine-private.log` for individual call timestamps and environment
subcalls. Current-thread CPU time excludes native worker threads; it must not
be interpreted as total process CPU utilization. Faster later runs alone do
not establish that instrumentation fixed an intermittent performance problem.

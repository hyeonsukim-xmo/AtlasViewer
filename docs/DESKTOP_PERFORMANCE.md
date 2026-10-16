# Desktop performance checks

## TODO: 보안 설치본 시작 지연 개선

등록: 2026-10-16. 상태: **보류 — 다음 개발 작업으로 추적**. 이번 요청은 할 일 정리이며 추가 구현·성능 시험은 진행하지 않는다.

현재 내부용 0.1.26에 전체 보호 엔진을 연결한 단일 실측은 메인 모듈 진입부터 첫 화면 표시까지 **166.48초**다. 이 중 전체 파일 내용 해시 검사가 **163.33초**, 파일 목록 열거가 1.41초였다. 현재는 시작할 때마다 전체 payload를 검증하며, 보호 엔진을 연결한 내부용과 고객용이 이 경로를 공유한다. 소스 개발 모드와 구분한다.

파일 목록 기준 용량(GB = 10⁹ bytes):

| 구성 | 파일 수 | 용량 |
| --- | ---: | ---: |
| 암호화 모델 자산 | 15 | 5.31 GB |
| 나머지 실행 환경·패키지 파일 | 88,894 | 17.47 GB |
| 합계 | 88,909 | 22.79 GB |

22.79 GB 전체가 모델 가중치는 아니다. 모델 크기와 다수 파일의 접근 비용이 각각 얼마나 시간을 차지하는지는 아직 분리 측정하지 않았다. 용량 비율로 소요 시간을 추정하거나 모델 크기만 원인으로 단정하지 않는다.

- [ ] **비용 분리:** 모델 자산과 실행 환경의 검사 시간을 따로 측정하고, 파일 열기·읽기·해시 연산의 기여를 확인한다. 분석 추론 시간과 앱 시작 시간을 분리한다.
- [ ] **실행 환경 차이 확인:** 같은 파일·장비·조건에서 Node 단독과 Electron의 차이를 좁힌다. 작은 파일 일부의 개선을 전체 앱 개선으로 환산하지 않는다.
- [ ] **검사 시점 설계:** 설치·업데이트·앱 시작·해당 분석 최초 사용 시점의 검사 범위를 검토한다. 화면 표시, 기존 결과 열람, 신규 분석 준비 시간을 구분하되 미검증 실행 코드·모델을 먼저 실행하지 않는다. 크기·수정 시각만으로 내용 검증을 대체하지 않는다.
- [ ] **배포 용량 검토:** 실행에 불필요한 파일과 환경 간 중복을 조사한다. 제거 후보는 CT/MRI/AP/LAT-LT/LAT-RT·분류기·PIV의 실제 의존성을 확인한 뒤 적용한다. 모델 가중치·정밀도·추론 설정 변경은 이 작업의 기본 해법에 포함하지 않는다.
- [ ] **보안 회귀 검증:** 변조·추가·누락 파일, 잘못된 서명, junction, 업데이트 중단을 검사한다. 검사 실패 시 신규 분석은 차단하고 기존 결과를 손상시키지 않는다.
- [ ] **공통 기능 회귀 검증:** 내부용·고객용의 공통 변경을 각각 확인하고, 동글 예외·장비 승인 정책과 저장소 분리를 유지한다. 패키지 구성 변경 시 전 모달리티의 로딩·분석·결과 읽기를 검증한다.
- [ ] **완료 판정:** 사용자 대기 시간 목표를 정하고 실제 패키지에서 변경 전후를 같은 조건으로 반복 측정한다. 재부팅 후 첫 실행과 반복 실행을 구분하고, 화면 표시·결과 열람·분석 준비까지의 시간 및 CPU/메모리/I/O를 기록한다. 더 빠른 PC에서의 재검증은 별도 결과로 남긴다.

이미 시도한 비동기 읽기·버퍼 재사용·파일 순서 변경·단일 worker·utility process는 전체 Electron 실행의 개선을 입증하지 못했다. 근거 없이 같은 시험을 반복하지 않는다. 상세 기록과 재현 명령은 [제품 보안 운영 문서](EXMO_PRODUCT_SECURITY_RUNBOOK.md)를 참조한다.

측정 근거: `outputs/security-check/9ba284d4-2ce7-4cb6-af80-f05863b2464d/startup-performance.json`. 용량 집계 근거: `work/security-delivery-v2/payload/files.json`의 `packages/**/*.enc`와 나머지 파일. 이 로컬 산출물은 Git에 포함되지 않으므로 위 기준 수치를 문서에 함께 보존한다.

[CT function-level timing diagnostics](EXMO_CT_TIMING_DIAGNOSTICS_2026-10-06.md)
documents exclusive metadata/validation/cleanup timings and private start/end
events, including per-package environment lookups. Library import breakdowns
appear separately in the report and are included in engine startup totals.

[단계별 재계측과 LAT 불일치 상세](EXMO_PIPELINE_TIMINGS_2026-10-04.md)
contains the newer, fully separated timing table. The older aggregate baseline
below is retained as historical evidence, not substituted for that table.

CT uploads its input once and stitches on GPU when its conservative memory gate
allows it. Insufficient memory selects the original CPU-input/CPU-stitch path
with GPU forward. A CUDA OOM releases the failed attempt and retries that path
once, without changing overlap, batch, precision, checkpoint or postprocessing.
Actual devices and the reason are recorded in `execution` and shown in QC.
The gate is an estimate, not a promise that arbitrary inputs fit. A failed CPU
stitch attempt still fails the job. Explicit CPU inference remains CPU-only.
See [the original GPU stitching validation](EXMO_CT_GPU_STITCHING_2026-10-05.md)
and [input residency and memory handling](EXMO_CT_INPUT_RESIDENCY_2026-10-05.md).

The current focused CT check compares host input versus resident GPU input,
both with GPU stitching, on the same loaded model/input: one warmup plus three
timed repetitions each. Input upload and final CPU transfer are included, and
input upload is also recorded separately. Every logits hash must match across
conditions and repetitions. This does not replace full native-result checks.
Its fast contract check covers low-memory routing, padding, OOM cleanup/retry
and error propagation without deliberately exhausting the GPU.

```powershell
work/modality-integration/envs/ct/Scripts/python.exe -X utf8 -B scripts/validate-ct-stitching.py
work/modality-integration/envs/ct/Scripts/python.exe -X utf8 -B scripts/validate-ct-stitching.py --real --output outputs/performance/ct-input-ab/report.json
```

Reports predating `execution.accumulation` are not automatically interchangeable
with new baselines. Keep their original reports and compare this intentional
execution change separately, including native Mask, metrics and Overlay parity.
Dynamic free-memory estimates are stored per trial as `gpuMemoryGate`, not
compared as fixed recipe settings. Actual input/accumulation devices and fallback
reasons remain recipe fields: different executed paths are not pooled silently.

Run from the repository root on the machine being optimized. The checker uses
the real Desktop import/classification, model service, scheduling, measurements,
Overlay and mesh code; it substitutes only Electron's shell/file picker. It does
not open or modify the user's analysis library. No extra dependency is required.

```powershell
npm run build:desktop
npm run performance:desktop
```

The default checks CT, MRI, X-ray AP, LAT-LT and LAT-RT, three times each on GPU.
All cases run sequentially. Each repetition starts a fresh model process through
the normal batch lifecycle. The input is imported once per case. OS file caches
are not flushed; the first and later samples are all retained, with no hidden
warmup exclusion. Do not run another analysis/game/GPU benchmark concurrently.
The bundled inputs are NIfTI/NRRD samples. This does not yet benchmark DICOM
series conversion, arbitrary image dimensions or a representative patient cohort.

Use `node` directly for options, including in PowerShell:

```powershell
node scripts/performance-desktop.cjs --engine-root "D:\EXMO\engine" --repeats 3
node scripts/performance-desktop.cjs --cases ct,mri --repeats 3 --output outputs/performance/change-01
node scripts/performance-desktop.cjs --cases lat_lt,lat_rt --repeats 3
node scripts/performance-desktop.cjs --batch-size 3 --repeats 3
node scripts/performance-desktop.cjs --baseline outputs/performance/before/report.json --threshold 15
node scripts/performance-desktop.cjs --compare-only outputs/performance/after/report.json --baseline outputs/performance/before/report.json
```

Engine lookup: `--engine-root`, then `EXMO_ENGINE_ROOT`, then the saved Desktop
engine configuration, then `work/modality-integration`. CPU is available via
`--device cpu`; it is never silently substituted for the requested GPU.

`--batch-size 1` measures per-case latency. A larger batch imports distinct copies
of the same sample and exercises overlap, memory admission and model reuse.
That is a controlled throughput probe, not a representative patient cohort.
Do not compare batch-size 1 latency directly with overlapping batch latency.

## Outputs and interpretation

- `report.json`: individual trials, stage timings, median/min/max/p95, runtime,
  GPU and process memory observations, source/model/config hashes and output
  equality signatures. With only three trials, p95 is the observed maximum,
  not a stable population percentile.
- `report.md`: stage-by-stage table across all routes first, followed by endpoint
  totals and optional baseline comparison.
- Per-trial numerical reports: native geometry, per-class measurements,
  delivered-reference and first-repetition voxel differences, Overlay checksums,
  GLB size. Reference differences are not the same as repeat differences.
- `checks-private.log`: numerical-check diagnostics. Engine logs, images and
  masks remain in the separate private temporary store named in the report.
  Retain that store for investigation; the checker does not delete artifacts.

Import/classification, initial-result availability, model-process elapsed time,
exclusive model stages, mesh generation and whole-batch time are different
measurements. Model-process time includes cold startup; pure inference does not.
New LAT timings separate preprocessing, five-fold inference with mirroring,
native restoration, QC and saving. Older reports retain their combined LAT
stage. CT/MRI serialization and readback verification are now separate; MRI
Slicer metadata construction is also separate. AP network forward is separate
from native restoration (which also includes tensor transfer and argmax).
Missing stages are `—`, not invented zeroes. GPU memory is Torch peak allocation; process peak
memory is that model process's peak, not total system or entire batch memory.
Numerical/Overlay verification runs after the timed batch and is excluded from
analysis latency. PNG timings in those checks are diagnostic, not interactive
slice-scroll FPS.
For overlapping batches, `ready` starts at each case's executor admission; use
`batchWall` and `throughputCasesPerMinute` to assess the entire submitted batch.
Batch statistics count each repetition once even when it contains multiple cases.

Repeated runs must preserve native Mask, measurements/QC and Overlay, including
MRI's generated PP500 mask and native measurements. This times the default Raw
result; on-demand Strong candidate generation is not part of the timed batch. Reference
differences against the delivered samples are reported separately: they are not
ground-truth accuracy, and may predate an optimization. A baseline performance
comparison also requires matching hardware/driver, runtimes, sample, model,
recipe, device, repeat count and batch size. Source-code hashes may change—that
is the point of optimization—but numerical equality must still pass.

The default regression threshold is 15% of baseline median for every mutually
measured stage and endpoint. A regression must also exceed 0.1 s to avoid failing
on tiny queue/timer fluctuations. Stages with a zero baseline cannot have a
percentage computed; their actual durations remain visible. `--threshold`
changes this engineering threshold; it is not a medical threshold. A changed
Mask cannot be approved merely by increasing the performance threshold.
Exit code 1 means failed/incomplete analysis, output mismatch, incompatible
comparison or a timing regression. The report identifies which occurred.
A repeated-output mismatch stops that case and records its failure; other
requested cases still run. Do not accept an unstable route as an optimization
baseline or loosen the equality check to make it pass.

Output directories must be new; existing reports are never overwritten. Partial
reports are saved after every completed trial and failed case. `Ctrl+C` cancels
the active Desktop batch; `--timeout 1800` limits each batch to 30 minutes.
The default locations `outputs/` and private temp storage are not Git content;
do not publish model, mask, imaging or private-log artifacts.

```powershell
node scripts/validate-performance-checker.cjs
```

This small check covers aggregation, absent stages, baseline compatibility and
rejection of faster-but-different outputs without invoking a model.

Stage timers are exclusive: nested measurements/verification are subtracted
from their outer save timer. Engine startup/IPC is measured as model-process
elapsed time minus the runner's elapsed time. Result worker overhead similarly
excludes its measured preparation work. These differences are labelled overhead,
not model loading or inference. Medians of individual stages need not sum to a
median endpoint; import occurs once before the timed repetitions. Independent
post-run numerical tests are not included in user-visible processing latency.

## Observed checks: 2026-10-04

RTX 3050 8 GB, one delivered sample per route, GPU, batch size 1. Seconds below
are medians of completed trials; import is separate. These are local observations,
not expected timings on another PC and not a controlled before/after speedup.

| Route | Completed trials | Results ready | Batch complete | Repeat equality |
|---|---:|---:|---:|---|
| CT | 3 | 182.65 | 195.18 | Pass |
| MRI | 3 | 76.30 | 79.43 | Pass, Raw and generated PP500 |
| X-ray AP | 3 | 20.71 | 21.60 | Pass |
| X-ray LAT-LT | 2 | 200.11 | 206.13 | Failed; third trial stopped |
| X-ray LAT-RT | 2 | 162.99 | 164.31 | Failed; third trial stopped |

CT/MRI measurements became available while 3D was still pending in every trial.
CT's largest measured stages were inference (91.33 s) and native restore
(32.56 s). MRI's export/verification was 33.28 s versus 3.19 s inference;
the earlier single-run 47.45 s export observation is not a repeated baseline.
LAT's combined inference/resampling was 145.46 s left and 134.27 s right.

LAT repeat masks changed by 241 pixels (left) and 186 pixels (right), each out
of 22,862,532. Measurements and Overlay also differed, so the overall report
failed. The delivered package already records LAT repeat differences in
`repeatability_details.json`. Its installed nnU-Net predictor enables CUDA
benchmark and autocast; these are candidates to investigate, not a demonstrated
cause. No model, precision, TTA or inference recipe was changed to force a pass.

Reference comparison is separate: CT matched the delivered reference; MRI had
40 differing voxels and AP 552 differing pixels, consistently across repetitions.
The stable baseline preserves these current outputs; it does not assert equality
to all delivered references or clinical acceptance of any discrepancy.

A separate AP batch-size-2 smoke check completed both identical outputs in
22.36 s, with model reuse on the second case. This was one batch, not a repeated
throughput benchmark.

Local artifacts under `outputs/performance/` (ignored by Git):

- `all-modalities-20261004/report.json`: original run, including LAT failures.
- `all-modalities-20261004/reviewed-report.json` and `.md`: same timings, with
  recipe hashes enriched after correcting Windows path normalization and paired
  LAT pixel-difference checks. Original input/reference/weight hashes were
  rechecked; recipe files predated the run. The original report is retained.
- `all-modalities-20261004/baseline-stable.json`: only CT/MRI/AP, with all three
  repetitions and Raw/PP500/measurement/QC/Overlay equality rechecked. LAT cannot
  be used as a strict optimization baseline yet.
- `ap-batch2-20261004/report.json`: the separate overlapping-batch smoke check.

On this same machine and engine, compare the stable routes after a future change:

```powershell
node scripts/performance-desktop.cjs --cases ct,mri,ap --baseline outputs/performance/all-modalities-20261004/baseline-stable.json
```

# Desktop performance checks

## TODO: 보안 설치본 시작 지연 개선

등록: 2026-10-16. 2026-10-17에 **`perf/slim-protected-runtime` 브랜치에서 배포 용량 축소 후보의 합성 입력·패키지 시작 검증과 제공 샘플 5종의 실제 GPU 추론·결과 화면 검증을 수행**했다. 기존 기준점은 `ced6e8c`이며 원본 엔진과 0.1.26 설치 파일은 보존한다. 샘플 시험에서 발견한 결과 읽기·표시 오류는 아래 후속 기록처럼 수정했다. 검사 시점 변경, 다양한 환자·입력 형식, 고객용 실물 동글·새 PC 검증은 미완료다.

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

### 2026-10-17: 배포 환경 축소 후보

아래 용량·시작 비교에 사용한 앱은 `0.1.27-runtime-slim.1`이다. 후속 샘플 시험 수정본은 `.2`이며 아래에 별도로 기록한다. 기본 `create` 경로를 자동 변경하지 않고, 이미 검증·서명된 payload에서 별도 후보를 만든다.

```powershell
node scripts/security/payload.cjs slim AUTHORITY SOURCE_PAYLOAD NEW_PAYLOAD slim-v1
node scripts/security/validate-portable-runtime.cjs NEW_PAYLOAD NEW_IMPORT_REPORT.json
node scripts/security/validate-protected-models.cjs NEW_PAYLOAD cuda:0
# 마지막 인자로 ct,mri,ap,lat_lt,lat_rt,xray-classifier 중 재검사할 항목만 지정할 수도 있다.
```

모델 암호문과 나머지 보존 파일은 원본의 서명된 해시와 복사 후 내용이 일치해야 한다. AP/LAT의 `torch` 전체가 동일한 경우에만 `envs/xray-common/Lib/site-packages/torch` 한 벌로 옮긴다. AP/LAT의 다른 패키지와 메타데이터는 각 환경에 유지한다. CT의 GPU 경로도 이 공통 PyTorch를 사용하며, CT CPU 및 MRI의 별도 PyTorch는 유지한다.

| 항목 | 원본 | 후보 |
| --- | ---: | ---: |
| 전체 파일 | 88,909 | 40,904 |
| 전체 bytes | 22,786,400,359 | 15,765,187,747 |
| 암호화 모델 | 5.31 GB | 동일 |

배포 payload에서 **7,021,212,612 bytes(30.81%)**, **48,005개 파일(54.0%)**이 줄었다. 원본과 후보를 함께 보존하므로 작업 PC에서 이만큼 디스크 공간이 확보됐다는 뜻은 아니다.

중복 없이 집계한 제외 내역:

| 분류 | 파일 수 | bytes |
| --- | ---: | ---: |
| PyTorch 개발용 include 및 lib/*.lib | 35,503 | 2,706,889,955 |
| 개발용 파일 제외 후 LAT의 중복 torch | 2,091 | 4,146,428,643 |
| NumPy/SciPy/pandas/SymPy의 tests 디렉터리 | 8,838 | 139,142,163 |
| Python 표준 라이브러리 test 디렉터리 | 1,573 | 28,751,851 |

`testing` 모듈, 라이선스, `.dist-info`, 실행 DLL, 다른 패키지는 일괄 삭제하지 않는다. 학습·C++ 확장 빌드·새로운 JIT 컴파일 용도로 이 축소 실행 환경을 사용하려면 별도 검증이 필요하다. 설치 위치에서 수동으로 삭제하는 방법은 사용하지 않는다.

공통 구조는 서명 정책의 `layout: xray-shared-v1`로 표시한다. 새 앱은 기존 구조도 지원하고, 구버전 verifier는 새 정책을 거부하므로 새 엔진만 구버전 앱에 넣지 않는다. 후보는 새 앱과 함께 배포해야 한다. 전체 파일 해시와 모델 연결 검증은 계속 수행한다.

원본 portable 환경의 실제 CT 모델 로딩 중 Python 3.12의 `distutils` 초기화 누락을 확인했다. 서명 검증이 끝난 `site-packages`에 표준 `site.addsitedir` 초기화를 적용해 `.pth` 설정을 실행한다. 기존 단순 import 검사는 MONAI까지 검사하지 않아 이 문제를 놓쳤으며, 이제 MONAI import와 실제 모델 로더 검사를 포함한다. 이 수정은 원본/후보 양쪽 비교에 동일하게 적용했다.

검증 범위와 기록:

- 원본: `outputs/security-models/cd21bf1d-1234-46da-8231-4544e5484a79/verification.json`.
- 후보: `outputs/security-models/9abb191f-551e-4886-b620-4eba98ba6b96/verification.json`.
- CT 96³, MRI 128³, AP 512×1024, LAT 좌우 각각 5 folds의 1792×768 합성 입력으로 RTX 3050에서 가중치 로딩과 GPU forward를 검사했다. 원본/후보의 logits 해시가 모두 같았다. 실제 환자의 전체 전처리·TTA·원본 복원 파이프라인 재실행은 아니다.
- 분류기는 합성 NRRD·DICOM을 비교한다. 원본 분류 출력 해시 추가 기록: `outputs/security-models/8784bc1f-f4cf-4fa6-ae4b-98f63aeaafbf/verification.json`.
- `outputs/security-slim-imports-20261017.json`: 5개 격리 Python 환경 및 실제 AP/LAT 공통 경로 확인.
- `outputs/security-slim-results-20261017.json`: 합성 CT/MRI/AP/LAT 양쪽의 측정·Overlay·암호화 저장, CT/MRI의 deferred 3D, MRI 강화 후보와 Raw 보존 통과.
- Node 보안 검사 32개, runtime 경로/초기화 검사 3개, 구버전 verifier의 새 구조 거부를 확인했다.

앱 시작 시간은 같은 ASAR·PC에서 원본/후보를 A/B/B/A 순서로 측정했다. Ryzen 5 5600X, RAM 32 GB이며, 모델 추론 등 다른 검증 작업을 동시에 실행하지 않았다. 파일 캐시는 비우지 않았다. 메인 모듈 진입부터 첫 화면 표시까지의 시간이며 설치·모델 로딩·추론 시간과 구분한다.

| 순서 | 환경 | 첫 화면 표시 | 파일 내용 해시 검사 |
| --- | --- | ---: | ---: |
| A1 | 원본 22.79 GB | 153.24초 | 149.71초 |
| B1 | 축소 15.77 GB | 90.45초 | 87.10초 |
| B2 | 축소 15.77 GB | 64.93초 | 62.32초 |
| A2 | 원본 22.79 GB | 174.47초 | 170.50초 |

이 조건에서 축소본이 빠르지만 여전히 1분 이상 걸린다. 2회씩의 소규모 비교이고 캐시 영향이 있으므로 재부팅 직후 시간이나 다른 PC의 속도로 일반화하지 않는다. 네 실행 모두 실제 패키지 main/preload, Windows CNG 등록, 온라인 승인, DPAPI 저장, 회수 상태와 결과 열람 검사를 통과했다. 실물 YubiKey를 사용하는 고객용 설치본 검증은 포함하지 않았다.

- 반복 기록: `outputs/runtime-slim-startup-20261017-retry.json`.
- 사용 ASAR SHA256: `a71bff7ea73fc6088b15acdd57f160fcc7380f2e0933ef964eea880c812d26c7`.
- 최초 시도 `outputs/runtime-slim-startup-20261017.json`에서는 원본이 화면 대기 한도 180초를 초과해 실패했다. 정확한 완료 시간은 없으며 정상 측정값에 넣지 않았다. 이 기록을 보존하고 QA 도구의 화면 대기를 300초로 늘린 뒤 위 네 번을 실행했다. 앱 검사를 생략하거나 조건을 완화한 것은 아니다.
- 후보 payload: `work/security-runtime-slim-20261017/payload`, 크기·제외 내역: `work/security-runtime-slim-20261017/payload.report.json`.
- 출력 일치·패키지 소스 일치·시작 측정 종합 확인: `outputs/runtime-slim-status-20261017.json`.
- 후보 앱: `release/internal/win-unpacked`, 기존 `EXMO-Atlas-Internal-Setup-0.1.26.exe` 보존. 신규 설치 파일 생성과 기존 브랜치 병합은 하지 않았다.

시작 검사는 `node scripts/security/check-internal-package.cjs PATH_TO_APP_ASAR AUTHORITY`로 실행한다. ASAR 옆 `engine/`에 비교할 서명 payload가 있어야 하며, 같은 앱으로 payload만 바꿔 순서별 기록을 보존한다. 원본 엔진을 덮어쓰지 않는다.

### 2026-10-17: 제공 샘플 입력부터 실제 출력까지

합성 forward 검사만으로 전체 분석 완료를 판단하지 않고, 같은 축소 엔진과 RTX 3050에서 제공 샘플을 실제 패키지의 main/preload/IPC로 등록하고 GPU 추론했다. 테스트 전용 CNG 등록·온라인 승인·모델 권한 발급·DPAPI 저장을 사용했다. 파일 선택 대화상자만 자동화하며 분석 worker와 모델은 대체하지 않는다. 사용자 결과 저장소 대신 `outputs/security-check/<UUID>`에 격리한다.

| 경로 | 실제 입력 (`work/modality-integration/packages/` 기준) | 수정 후 확인한 출력 |
| --- | --- | --- |
| CT | `EXMO_CT/samples/EXMO_CASE_001/input_ct.nii.gz` | 암호화 mask, 32개 구조 측정, 3방향 Overlay·슬라이스 이동, GLB 및 3D 화면 |
| MRI | `EXMO_MRI/samples/sample_01/W.nrrd` | 암호화 mask, 28개 구조 측정, 3방향 Overlay·슬라이스 이동, GLB 및 3D 화면 |
| AP | `EXMO_XRAY/samples/AP/AP_01/input.nrrd` | 분류 경로, 암호화 mask, 면적 측정, Overlay 화면 |
| LAT-LT | `EXMO_XRAY/samples/LAT_LT/LAT_LT_01/input.nrrd` | 분류 경로, 암호화 mask, 면적 측정, Overlay 화면 |
| LAT-RT | `EXMO_XRAY/samples/LAT_RT/LAT_RT_01/input.nrrd` | 분류 경로, 암호화 mask, 면적 측정, Overlay 화면 |

첫 실행을 그대로 통과 처리하지 않았다. 5개 모델의 GPU 추론은 완료됐으나 CT/MRI는 3D 전달에서, LAT 양쪽은 결과 확정에서 실패했다. 다음 두 문제를 수정하고 `0.1.27-runtime-slim.2`로 다시 패키징했다.

1. **긴 Windows 경로의 GLB 로딩:** 270자 결과 경로의 파일은 존재했지만 Chromium `file:` fetch가 `ERR_FILE_NOT_FOUND`를 반환했다. 등록된 결과 GLB만 Node 파일 스트림으로 전달한다. 기존 경로·origin·method 제한과 CSP를 유지하며 존재하지 않는 결과 404, POST 403도 검사했다.
2. **LAT NRRD의 선택적 `space origin`:** 실제 모델 출력에 이 항목이 없어 암호화 reader가 실패했다. 일반 SimpleITK reader와 동일하게 생략 시 원점 `(0, 0, 0)`을 사용한다. LPS/RAS 각각에서 암호화 전후 origin·spacing·direction·voxel 일치 회귀 검사를 추가했고 artifact 검사 2개를 통과했다.

완료된 GPU 추론은 다시 실행하지 않았다. LAT 두 건은 동일한 암호화 mask를 유지한 채 수정된 worker의 결과 확정만 수행했다. 이어서 수정된 앱에서 **5개 저장 결과 전부 측정·Overlay 화면을 열었고 CT/MRI의 실제 3D 화면까지 확인**했다. GLB의 크기·버전·mesh·vertex 존재, 측정값 유효성, 입력 해시 불변을 검사했다. MRI는 PP500·강화 후보의 Overlay와 3D 생성, Raw 암호문 불변 및 Raw 복귀도 통과했다. 따라서 수정본에서 신규 입력부터 추론까지 모두 한 번 더 반복한 기록과는 구분한다.

재현 명령:

```powershell
# 새 격리 저장소에서 입력 등록부터 실제 모델 실행·결과 화면까지 (기본 5종)
node scripts/security/check-internal-package.cjs PATH_TO_APP_ASAR AUTHORITY work/modality-integration
# 완료된 QA 결과만 재검사: 추론은 재실행하지 않음
node scripts/security/check-internal-package.cjs PATH_TO_APP_ASAR AUTHORITY work/modality-integration ct,mri,ap,lat_lt,lat_rt outputs/security-check/PREVIOUS_UUID
```

재검사 모드는 이전 QA 폴더만 허용하고 입력 해시·결과 ID를 대조한다. 누락된 결과를 자동 복구하는 제품 기능은 아니다. 검사 코드는 `scripts/security/validate-analysis-samples.cjs`다.

로컬 근거(영상·mask·테스트 키는 Git에 넣지 않음):

- 실제 추론 및 최초 실패 기록: `outputs/security-check/8bbff1b7-9651-4532-82a3-b0d53d9c1768/analysis-samples.json`.
- LAT 결과 확정과 mask 불변 기록: 같은 폴더의 `recovered-finalization.json`.
- 최종 5종 `complete: true`, `passed: true`: `outputs/security-check/fc6b3549-5f47-414f-a36f-d7570e5bb308/analysis-samples.json`. 같은 폴더에 `*-result-ui.png`, `ct-3d-ui.png`, `mri-3d-ui.png`를 보존했다.
- 수정 앱: `work/security-runtime-slim-20261017/qa-slim-v2/resources/app.asar`, SHA256 `53a267653239e01c5cd68d04fa62df7753642151e9c6521b841e5a25bdf85fae`. 엔진과 가중치는 앞의 축소 후보 그대로다.

이 시험은 NIfTI/NRRD 샘플 각 경로 1건의 기능 확인이며 임상 정확도나 다양한 환자의 전체 회귀 보장은 아니다. DICOM 폴더·ZIP 신규 입력, 실물 YubiKey 고객 프로필, 다른 PC 및 새 설치 파일 검증은 이번에 수행하지 않았다. 시작 A/B 수치는 위 `.1` 기록을 유지하며 이번 기능 시험을 새로운 성능 비교로 사용하지 않는다.

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

# CT NRRD 대량 가져오기 및 분석 처리 변경 기록

## 2026-10-03 문서화 기준

이 문서는 GitHub에 반영한 `48419f4` (`0.1.11`)의 구현을 기준으로 한다.
아래의 0.1.3 기록은 당시의 측정 결과이며, 최신 구현의 성능 측정으로
해석하지 않는다. 이후 로컬에서 진행 중인 버전 변경이나 검증 스크립트 수정은
이 기준에 포함하지 않는다.

## 사용 흐름

1. Desktop에서 분석 종류를 선택하고 영상을 추가한다. 등록 진행률과 개별
   성공·실패를 확인할 수 있으며, 완료한 항목부터 목록에 저장된다.
2. CT NRRD의 `헤더 확인됨`은 전체 영상 검증 완료를 뜻하지 않는다.
   분석 전에 실제 데이터 검증, 필요한 HU 확인, NIfTI 변환을 수행한다.
   성공한 지연 검증 결과는 카탈로그에 저장해 다음 실행에서 재사용한다.
3. 분석 대상을 선택하고 검토한다. 검토 화면은 페이지당 4개 영상을 표시하며,
   페이지 이동으로 불필요해진 대기 미리보기 요청은 전송 전에 건너뛴다.
   이미 실행 중인 디코딩을 중단하는 기능은 아니다.
4. 조건 확인을 마친 실행 가능 항목을 분석한다. 전체 완료·실패 개수와
   활성 항목별 처리 단계·진행률을 표시한다. 개별 완료 결과는 배치가 끝나기
   전에도 결과 목록에 나타난다.
5. 취소하면 대기 작업과 소유한 분석 프로세스를 중단한다. 이미 게시한 결과는
   유지하며, 미완성 결과는 완료 결과로 게시하지 않는다. 항목 하나의 실패는
   이후 항목 실행을 막지 않지만, 실패가 있으면 배치 최종 상태는 `failed`다.

## 분석 실행 구조

| 영역 | 구현과 제한 | 주요 소스 |
| --- | --- | --- |
| 배치 실행 | 한 번에 하나의 배치. GPU 선택 시 최대 3개 항목의 서로 다른 단계를 겹쳐 처리하고 CPU 선택 시 1개씩 처리 | `desktop/imaging.cjs` |
| 자원 제한 | GPU 추론 1개, 모델 작업 최대 2개, CPU 후처리 1개, 결과 준비 1개. CPU 후처리와 별도 결과 준비는 겹칠 수 있음 | `desktop/analysis-pipeline.cjs` |
| 메모리 예약 | 영상 크기·간격에 따른 추정량으로 FIFO 입장을 제어. 예약 예산 초과 항목은 단독 입장 가능. 실제 메모리 사용량의 강제 제한이나 OOM 방지 보장은 아님 | `desktop/analysis-pipeline.cjs` |
| 모델 서비스 | 배치 동안 모델 프로세스와 가중치를 재사용. 가중치 파일의 서명 변경 시 캐시를 무효화하고 배치 종료 시 작업 프로세스를 정리 | `desktop/model-service.py`, `desktop/model-runner.py` |
| 프로세스 통신 | 작업 ID별 응답·진행 이벤트 연결, 프로세스 종료 처리, 취소 및 중복 종료 처리 | `desktop/analysis-worker.cjs` |
| 결과 게시 | 측정·Overlay·3D 준비가 끝난 뒤 `published.tmp`를 `published.json`으로 바꾸어 게시 | `desktop/imaging.cjs` |
| 절전 방지 | 실행 중 `prevent-app-suspension`을 사용하고 배치 종료 시 해제 | `desktop/imaging.cjs` |

CT는 UNETR/MONAI 1.3.2 FP32 경로에서 GPU 추론을 지원하며, predictor
microbatch 기본값은 4다(허용값 1, 2, 4; CPU에는 적용하지 않음).
원본 좌표 복원은 33개 클래스 확률을 작은 깊이 블록으로 재표본화하고,
유한값·범위·확률 합을 확인한 뒤 정규화와 원본 격자 argmax를 수행한다.
물리적 좌표·클래스별 선형 보간·최종 라벨 의미를 유지하려는 구현이며,
수치적 동등성은 별도 실영상 검증 결과로 판단해야 한다.

## 확인한 검증과 재실행 방법

2026-10-03에 `48419f4`를 푸시하기 전에 다음 검사를 실행하여 통과했다.
이번 문서 보완은 그 실행 결과를 기록하며 GPU 추론을 다시 실행한 것은 아니다.

```powershell
npm run check
npm test
npm run test:language
node scripts/validate-analysis-pipeline.cjs
node scripts/validate-analysis-worker.cjs
node --experimental-strip-types scripts/validate-preview-queue.mjs
node scripts/validate-prepared-input-cache.cjs
npm run build
npm run build:desktop
```

- 기존 atlas 무결성·상호작용 검사와 283개 영어 번역 검사가 통과했다.
- 자원 예약·CPU/GPU 단계 겹침·취소·실패 후 계속 실행은 모의 작업으로
  검증했다. 실제 GPU 실행 속도나 모델 출력 정확도를 검증한 결과는 아니다.
- 작업 프로세스 테스트는 응답 분배, 종료 후 재시작, 취소, 중복 종료를 확인했다.
- 미리보기 테스트는 오래된 페이지 요청 건너뛰기, 직렬 실행, 실패 후 진행을
  확인했다. 입력 캐시 테스트는 성공한 검증만 저장하고 원본을 보존함을 확인했다.
- 웹·Desktop 빌드는 성공했으며, 번들 크기 500 kB 초과 경고가 남아 있다.
- 실영상 통합·GPU 수치 비교·패키지 GUI 재검증은 위 실행 범위에 포함하지 않았다.
  관련 스크립트가 저장소에 있다는 사실만으로 통과를 의미하지 않는다.
  `validate-pipeline-real.cjs`, `validate-pipeline-masks.py`,
  `validate-ct-streaming-geometry.py`, `validate-ct-streaming-result.py` 등은
  별도 로컬 엔진과 입력·참조 결과가 필요한 검증 도구다.

## 로컬 NRRD 정리 작업 기록

압축 내부의 긴 경로 때문에 Windows 탐색기에서 해제가 실패하여 긴 경로를
지원하는 파일 API로 해제했다. 이후 사용자가 이름을 바꾼 `robot_imaging`
폴더에서 NRRD 117개(약 11.28 GiB)를 별도 `robot_imaging_nrrd` 폴더로 복사했다.

- `CT.nrrd` 대신 바로 위 폴더 이름을 사용하고 끝의 `_nrrd`를 제거했다.
- 같은 상위 폴더 이름이 겹치면 그 위의 `AN_날짜_시간`을 붙이고,
  그래도 겹치면 번호를 추가하여 덮어쓰기를 피했다.
- 원본은 보존했고 117개 복사본 전체의 SHA-256이 원본과 일치함을 확인했다.
- 로컬 `file_mapping.csv`에 새 이름, 원본 경로, 크기, SHA-256을 저장했다.

이 작업은 일회성 로컬 파일 정리이며 Desktop의 내장 가져오기 기능이나
저장소에 제공되는 자동 정리 명령은 아니다. 영상과 원본 경로를 포함한 매핑
파일은 GitHub에 올리지 않았다. 파일 동일성 확인은 영상의 임상적 유효성이나
앱에서의 분석 성공 여부를 뜻하지 않는다.

## 설치와 문서 범위

소스 업데이트는 앱 설치를 자동으로 갱신하지 않는다. 현재 체크아웃한 소스로
`npm run desktop:dist`를 실행하면 `package.json` 버전에 맞는
`release/EXMO-Atlas-Setup-<version>.exe`를 생성한다. 설치 파일과 로컬 모델
엔진은 별도이며 GitHub 소스 푸시에 포함하지 않는다.

## 0.1.3 당시 기록

아래 내용은 2026-09-30 수정과 당시 환경에서의 검증·설치 기록이다.

## Cause

The previous importer sent every selected image in one worker request with a
five-minute deadline. CT NRRD import decoded all voxels, validated all values,
converted and compressed each volume as NIfTI, then hashed it. The catalog was
saved only after the entire request finished. A timeout discarded that import.

## Changes

- CT NRRD registration reads headers and checks dimensions, channel count,
  spacing and physical orientation without decoding the full payload.
- The app still takes a private snapshot. Its NRRD bytes remain unchanged; the
  snapshot is moved into storage instead of copied and recompressed again.
- Full intensity/payload validation, HU confirmation and NIfTI conversion remain
  mandatory before CT inference. Hash evidence binds to the converted input.
- Standalone image requests have separate deadlines. Each completed item is
  saved immediately; a failed item is shown as failed while later items continue.
- DICOM files are kept together for series grouping; their import path is not
  converted to header-only registration by this change.
- The UI shows registration progress and distinguishes header verification from
  full input verification. Korean and English strings are included.
- Clearing inputs preserves directories referenced by completed results, including
  the deferred conversion file used by CT results.

## Verification

- scripts/validate-bulk-import.py: actual CT sample (512 × 512 × 185) exported as
  a 72,133,361-byte compressed NRRD; header registration approximately 0.094 s.
  Checks unchanged bytes, exact voxel parity and physical geometry after deferred
  conversion, mandatory HU confirmation, evidence hashes, and rejection of
  constant/corrupt data before inference.
- scripts/validate-bulk-import.cjs: actual backend and Python worker; only the
  Electron file picker and IPC shell are replaced. Imports the representative
  sample 118 times, including actual private file copies (~8.51 GB total).
  Packaged backend: 118 registered in 9.20 s. Intermediate catalog saves and
  restart persistence pass. A deliberately forced timeout affects one item only;
  the preceding and following items remain registered.
- This repeated-sample benchmark is not a timing guarantee for 118 distinct user
  files. The original failing selection was not available for a direct replay.
- TypeScript, 244-entry language validation, atlas integrity, existing interaction
  tests and production desktop build pass.
- A first packaged test attempt reported a filesystem-access error; the diagnostic
  rerun passed. The underlying transient cause was not established.
- Real Electron GUI revalidation was blocked in this restricted session by GPU
  process startup failures. No full segmentation inference was rerun for this fix.

Reports: outputs/bulk-import-check (ignored). Tests use workspace-only temporary
libraries and do not alter the installed application's results or configuration.

## Apply update

Close EXMO Atlas, run:

release/bulk-import-0.1.3-verified/EXMO-Atlas-Setup-0.1.3.exe

Then reopen the desktop shortcut and add the images again. Existing engine and
library paths are unchanged. This session can create the installer in the
workspace but cannot update the installation under AppData; installation is a
separate user action. These source changes were subsequently included in commit
`48419f4`; the historical installer path above is not the current release path.

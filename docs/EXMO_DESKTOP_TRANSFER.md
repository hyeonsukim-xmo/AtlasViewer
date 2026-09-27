# EXMO Desktop · 다른 Windows PC로 옮기기

이 폴더는 앱 설치 파일, CT/MRI/X-ray 원본 모델 묶음, 고정된 Python 환경 설치 도구, 실제 샘플 검증 명령을 포함한다. 모델 원본은 GitHub에 포함하지 않는다. 소스는 `source.zip`과 `transfer-manifest.json`의 Git commit으로 연결한다.

## 새 PC에서 실행

1. **폴더 전체**를 새 PC의 로컬 디스크로 복사한다. `models`만 빠뜨리거나 설치 EXE만 복사하면 분석 엔진이 설치되지 않는다.
2. 인터넷에 연결한 뒤 `01-Install.cmd`를 실행한다. Python·Node·Git을 미리 설치할 필요는 없다. 설치 도구가 전용 Python 3.12.8과 CT/MRI/AP/LAT 환경을 생성하고 모델 무결성 및 CPU/CUDA 실행을 확인한 다음 앱을 설치한다.
3. `02-Verify-workflows.cmd`를 실행한다. 제공 샘플 CT 1건, MRI 1건, X-ray AP/LAT-LT/LAT-RT 각 1건을 **실제로 추론**하고 측정·Overlay·3D까지 검사한다. CT가 CPU 방식이라 전체 검사에는 수십 분이 걸릴 수 있다. 완료 메시지가 나오기 전에 창을 닫지 않는다.
4. 바탕화면의 **EXMO Atlas**를 열고 CT / MRI Water / X-ray 작업을 선택한다. 아래 샘플 경로의 입력 영상을 등록해서 화면 조작까지 확인한다.

첫 설치는 Python 및 고정된 패키지를 다운로드한다. 준비가 끝난 로컬 분석에는 인터넷이 필요하지 않다. 방화벽 환경에서는 `github.com`, `raw.githubusercontent.com`, `pypi.org`, `files.pythonhosted.org`, `download.pytorch.org` 다운로드 접근이 필요하다. 이 버전은 오프라인 최초 설치 묶음이 아니다.

설치 재시도 전에 실행 중인 EXMO Atlas를 닫는다. 모델·환경 설치 폴더를 임의로 옮기거나 그 안의 `python`을 삭제하지 않는다. 다른 위치로 바꿀 때는 아래 명령으로 다시 설치한다. 기존 `engine.json`은 설정 변경 전에 백업된다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-desktop-transfer.ps1 -EngineRoot "D:\EXMO\engine"
```

## 장비와 저장 위치

| 항목 | 기준 |
| --- | --- |
| OS | Windows x64. ARM/macOS/Linux 배포 패키지가 아니다. |
| 검증 기준 장비 | Windows, RTX 3050 8 GB, NVIDIA driver 591.86, RAM 32 GB |
| GPU | MRI/AP/LAT는 이 묶음의 Torch CUDA 12.8/12.6 환경에서 동작하는 NVIDIA GPU. 설치 시 실제 CUDA convolution을 실행해 확인한다. 새 GPU 세대/드라이버도 무조건 지원한다고 가정하지 않는다. |
| CPU | CT는 제공된 FP32 CPU recipe를 유지한다. 임의로 GPU/AMP로 바꾸지 않는다. |
| RAM/디스크 | RAM 32 GB와 설치·임시 결과를 위한 여유 디스크 80 GB 권장. 이는 최소 사양 인증값이 아니라 현재 샘플을 기준으로 잡은 준비 용량이다. |
| 엔진 기본 위치 | `%LOCALAPPDATA%\EXMO Atlas\engine` |
| 엔진 연결 설정 | `%APPDATA%\EXMO Atlas\engine.json` |
| 앱의 입력·분석 결과 | `%APPDATA%\EXMO Atlas\imaging` |
| 설치 환경 검사 | `<engine>\runtime-check.json` |
| 실제 샘플 검사 | `<engine>\validation\transfer-날짜-시각-ID\workflow-check.json` 및 케이스별 비공개 로그/Overlay |

DLL 누락으로 Torch import가 실패하면 Microsoft의 [Visual C++ x64 Runtime 설치 안내](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)를 확인하고 설치 후 재시도한다. NVIDIA 드라이버 설치와 PC 재부팅은 이 설치 도구가 자동으로 수행하지 않는다.

CPU 실행은 명시적으로 선택할 수 있다. 이 경우 설치 검사는 GPU를 요구하지 않지만 MRI/X-ray 전체 CPU 처리 시간·품질 재현은 별도로 검증해야 한다. 앱에서 분석할 때도 실행 버튼 옆 추론 장치를 `CPU`로 선택한다. 자동 CPU fallback은 없다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-desktop-transfer.ps1 -Device cpu
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-desktop-transfer.ps1 -WorkflowCheck -Device cpu
```

전용 Python은 [uv의 managed Python 기능](https://docs.astral.sh/uv/concepts/python-versions/#managed-and-system-python-installations)으로 엔진 폴더에 설치한다. 기존 PC의 가상환경이나 `C:\Users\inhag` 경로를 복사해서 의존하지 않는다. 포함한 uv의 버전·라이선스는 `tools`에 있다.

## 샘플과 작업 순서

아래 경로의 기준은 `<engine>\packages`다. 기존 사용자의 실제 환자 목록/완료 결과는 이 이관 폴더에 들어 있지 않으며 새 PC의 최근 결과 목록은 비어 있는 상태로 시작한다. 제공된 개발 샘플·reference Mask는 원본 모델 묶음 내부의 비공개 자료다.

| 작업 | 입력 파일 |
| --- | --- |
| CT | `EXMO_CT\samples\EXMO_CASE_001\input_ct.nii.gz` |
| MRI Water | `EXMO_MRI\samples\sample_01\W.nrrd` (비교용 `sample_02`, `sample_03`도 포함) |
| X-ray AP | `EXMO_XRAY\samples\AP\AP_01\input.nrrd` |
| X-ray LAT-LT | `EXMO_XRAY\samples\LAT_LT\LAT_LT_01\input.nrrd` |
| X-ray LAT-RT | `EXMO_XRAY\samples\LAT_RT\LAT_RT_01\input.nrrd` |

화면에서는 분석 선택 → 영상/Series 등록 → 미리보기와 입력 검토 → 선택 항목 Segmentation → 측정값·QC·Overlay → CT/MRI 3D 순서다.

- CT/MRI는 DICOM series, self-contained NRRD, mm 단위/유효 affine의 NIfTI `.nii`/`.nii.gz`를 검토한다. Enhanced/multiframe·불균일 geometry 등 현재 거부하는 입력을 이관한다고 새로 지원하지 않는다. CT HU 및 MRI Water 확인 조건도 유지한다.
- X-ray는 제공 NRRD의 AP/LAT-LT/LAT-RT 분류·분할을 사용한다. X-ray DICOM은 미리보기·분류까지만 가능하며 분할은 아직 지원하지 않는다. X-ray 결과는 면적 cm²와 Overlay이며 CT/MRI 같은 3D 체적을 생성하지 않는다.
- MRI는 Raw / PP500 / 강화 검토 후보를 비교한다. 원본 Raw는 보존한다. 강화 후보가 임상적으로 정확한 교정이라는 뜻은 아니다.
- 최대 3개 결과의 측정값/QC/Overlay/3D를 비교한다. X-ray AP와 LAT는 class 구성이 달라 함께 비교하지 않는다.
- 3D는 선택 동기화, 좌우 쌍 선택, 전체 Explode/Assemble, 각 케이스의 우클릭 회전, hover 좌우 측정을 유지한다. 테이블은 행 전체 선택, 헤더 전체선택과 너비 조절을 제공한다.
- 웹에는 로컬 업로드·분석 엔진이 포함되지 않는다. 계정·서버 결과 동기화는 아직 구현되지 않았다.

## 검증 결과 해석

`runtime-check.json`의 `passed`는 네 환경의 pinned dependency/import/실제 CPU·CUDA tensor 실행 결과다. 모델을 전부 실제 영상으로 실행했다는 뜻은 아니다.

`workflow-check.json`의 `allRequestedCasesPassed`는 요청한 실제 샘플의 등록·분류·추론·native 측정·PNG Overlay·CT/MRI GLB와 MRI 세 variant 처리가 완료됐다는 뜻이다. 제공 reference와 다른 voxel 수도 기록한다. 플랫폼별 수치 차이를 0으로 꾸미거나 정답 대비 정확도로 표시하지 않는다. 이 파일이 없거나 중간 case만 있으면 전체 검사를 통과한 것으로 보지 않는다.

자동 검사는 앱의 기존 Python 어댑터를 그대로 사용하지만 새 PC의 마우스/GPU 화면 조작을 대신하지 않는다. 실제 앱에서 다음을 확인한다.

1. 엔진 세 작업이 연결된 상태이며 각 샘플 미리보기가 열린다.
2. CT/MRI 방향 토글·휠·가운데 버튼 드래그·Overlay가 작동한다.
3. 실제 분석 완료 후 측정값/QC가 나오고 앱을 다시 열어도 결과가 남는다.
4. MRI 세 케이스 비교, 표 행 선택, 동기화된 Explode/Assemble, 우클릭 독립 회전과 좌우 hover를 확인한다.
5. X-ray 세 방향을 각각 실행한다. AP와 LAT를 혼합 비교하는 동작은 거부되어야 한다.

현재 모델의 해부학적 품질 한계도 그대로다. 특히 sample_01 sartorius의 큰 좌우 차이는 원본 예측 단계부터 존재한다. 좌우 배정/체적 보존 검사와 분할 경계의 정확성 검증을 혼동하지 않는다. 상세 기록은 `source.zip` 안의 `docs/EXMO_MODALITY_VALIDATION_2026-09-27.md`에 있다.

## 무결성과 실패 시 확인

`01`과 `02`는 `transfer-manifest.json`의 파일 SHA-256을 먼저 확인한다. 모델 추출 시에는 고정된 archive hash와 원본 내부 manifest도 검사한다. 손상된 파일은 다시 복사하고 검사를 우회하지 않는다. 이 해시는 복사 무결성 검사이며 코드 서명을 대신하지 않는다. 현재 EXMO 설치 파일은 내부용 미서명 빌드다.

```powershell
# 설치나 앱 설정 변경 없이 이관 파일만 확인
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-desktop-transfer.ps1 -VerifyOnly
```

새 PC의 오류는 `runtime-check.json` 또는 실패 case의 `inference-private.log`를 확인한다. 실패한 검사를 반복할 때는 새 validation 폴더를 생성하므로 기존 완료 결과를 덮어쓰지 않는다. 실제 사용자 `imaging` 폴더를 삭제하는 초기화 명령은 없다.

이관 폴더에는 비공개 모델·reference Mask가 포함된다. GitHub·웹 배포·공개 다운로드 경로에 올리지 않는다. 이 구현은 PC 소유자의 로컬 파일 접근을 막는 DRM을 제공하지 않는다. 기존 분석 기록을 나중에 옮길 때는 저장된 절대 경로도 다시 연결해야 하므로 `%APPDATA%` 폴더를 단순 복사하는 방식은 지원되는 이관 절차로 보지 않는다.

## 개발자가 이관 폴더를 다시 만들 때

작업 트리를 commit한 상태에서 앱을 빌드하고 새 출력 폴더를 지정한다. 실행 중인 앱의 배포 폴더를 덮어쓰지 않는다.

```powershell
npm ci
npm run build:desktop
npx electron-builder --win nsis --x64 "--config.directories.output=work/desktop-transfer-build"
work\modality-integration\envs\ct\Scripts\python.exe -X utf8 scripts/build-desktop-transfer.py --source "D:\PrivateDeliveries" --installer "work/desktop-transfer-build/EXMO-Atlas-Setup-0.1.0.exe" --uv "$env:USERPROFILE/.local/bin/uv.exe" --output "D:\EXMO-Desktop-Transfer"
```

원본 archive 세 개의 파일명은 `EXMO_CT.zip`, `EXMO_MRI.tar.gz`, `EXMO_XRAY.zip`이다. source commit과 설치 파일을 같은 코드로 생성했는지 검증한 후 이관한다.

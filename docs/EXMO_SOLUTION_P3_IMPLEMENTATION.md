# P3 — 선택 설치·업데이트·공용 Viewer

2026-10-18, `feat/solution-productization`, P2 기준점 `5ce545f` 이후 변경.

Desktop의 CT/MRI/X-ray를 선택 설치하는 경로를 추가했다. 기존 source 개발 실행과 단일 signed payload 설치 경로도 유지한다. 모델·전처리·patch/overlap·정밀도·좌표 복원·후처리 수식은 변경하지 않았다. 공용 Viewer는 기존 CT 환경에서 필요한 배포 파일을 그대로 추출하며 새 패키지를 설치하거나 업그레이드하지 않는다.

## 실제 설치 경계

| 선택 | 필수 구성 | 포함하지 않는 모델 |
| --- | --- | --- |
| 공용 Viewer | portable Python, reader, 보안/동글 환경, 고정 adapter·palette·trust | CT/MRI/X-ray 전부 |
| CT | 공용 + GPU 공통 환경 + 기존 CT 환경·암호화 모델 | MRI, X-ray |
| MRI | 공용 + 기존 MRI 환경·암호화 모델 | CT, X-ray |
| X-ray | 공용 + GPU 공통 환경 + LAT 환경·AP/LAT-LT/LAT-RT·분류 암호화 모델 | CT, MRI |

GPU 공통 구성은 기존 `envs/ap`와 `envs/xray-common`이다. CT가 이미 이 CUDA PyTorch를 사용하므로 수치 경로를 바꾸지 않고 공유한다. AP 모델 자체는 X-ray 구성에만 있다. 기존 `solutions.cjs.runtimes`는 legacy 경로의 매핑이며, 선택 설치의 실제 의존성은 `desktop/security/selection.cjs`의 고정 GRAPH가 정한다.

이번 내부 bundle의 압축 전 크기:

| 구성 | bytes | 파일 수 |
| --- | ---: | ---: |
| 공용 | 500,113,157 | 8,183 |
| GPU 공통 | 4,309,089,930 | 7,345 |
| CT 추가 | 1,079,297,630 | 7,890 |
| MRI 추가 | 4,776,191,315 | 9,443 |
| X-ray 추가 | 5,452,785,918 | 11,668 |

공용 reader는 20개 배포 패키지의 정확한 dependency closure다. torch/monai를 포함하지 않는다. 버전·의존 관계·파일 목록은 builder의 `.report.json` 및 서명된 component inventory에 남긴다. 이 크기는 현재 내부 bundle 기준이며 차후 구성 변경 때 다시 산출한다.

## 검증·권한·원자적 전환

- `catalog.json`: issuer가 서명한 고정 선택 목록. 임의 workflow, URL, 실행 명령을 제공할 수 없다.
- 각 component: 서명 token → `files.json` hash → 파일별 크기·SHA-256. 경로 소유권, 중복, symlink/junction, 누락·추가 실행 파일, profile 불일치를 거부한다.
- 선택 manifest: reader/ct/mri/xray별 정확한 component digest와 model digest. v3 `packageSetDigest`는 이 선택 token에 결합된다. 실행 recipe는 frozen adapter의 실제 바이트에 결합된다.
- 설치 전 및 활성화 직전에 기존 v3 권한을 확인한다. customer는 PC·동글 증명을 수행한다. 설치·업데이트·롤백이 별도의 무인증 경로가 되지 않는다.
- `staging/<transaction>`에 복사하고 전체 검증한 뒤 `sets/<uuid>`로 이동한다. 최종 `active.json` 교체 전에는 기존 선택을 바꾸지 않는다. 여러 제품을 한 번에 선택하면 한 transaction으로 전환한다.
- `previous.json`은 제품별 이전 선택을 보존한다. CT 업데이트 후 MRI를 업데이트해도 CT 이전 버전을 잃지 않는다. 롤백도 현재 유효한 해당 버전 권한이 있어야 한다.
- 실행 직전 선택 closure 전체를 다시 hash 검증한다. mtime·크기만 믿고 통과시키는 캐시는 없다. 실행 중 worker는 자신이 시작한 set을 pin한다.
- 공유 파일은 이번 transaction에서 검증한 **내부 set의 같은 경로·hash·크기**만 hard link한다. 외부 NAS/배포 폴더에는 link하지 않는다. link 불가 시 복사한다.
- Electron 단일 인스턴스와 manager의 busy 상태가 저장소 writer를 직렬화한다. 별도 외부 프로세스가 이 저장소에 직접 쓰는 API는 제공하지 않는다.
- 중단된 staging은 다음 시작 때 정리한다. 활성/이전/실행 중 set은 보존하며, 잠긴 은퇴 파일은 다음 정리 때 재시도한다. 서명된 이전 reader는 계속 보관한다.
- 시작 시 공용 reader가 손상되었으면 설치 파일에 포함된 서명 공용 패키지로 복구한 뒤 관리 화면을 연다. 손상된 분석 패키지의 실행 차단은 유지한다. 동일 recipe reader로 복구된 결과는 연속 slice/Overlay 조작 시 worker를 계속 재사용한다.

`sets`는 앱이 덮어쓰지 않는 저장 방식이다. 같은 사용자나 관리자 권한의 외부 프로그램을 OS 차원에서 절대 차단한다는 의미가 아니다. 재검증과 실행 승인, 암호화 모델 로딩 경계는 그대로 유지한다.

## 결과와 실행 버전

새 결과의 인증된 snapshot에 `readerId`를 기록한다. 측정값·Overlay·mesh는 그 reader의 동일 recipe로 읽는다. 새 후처리는 현재 설치·권한의 recipe로 계산하되, 이전 source snapshot의 Mask hash·인증 tag·origin/revision을 확인한다. 새 recipe가 이전 표시 recipe와 다르다는 이유만으로 승인된 새 후처리의 입력을 거부하지 않는다.

모델을 제거해도 reader와 확정 결과를 보존한다. 모델 제거·권한 만료·회수는 기존 결과 읽기나 동일 Mask 표시 mesh 재생성의 승인 조건이 아니다. reader 없는 과거 결과는 처음 도입한 reader에 귀속한다. 동일 서명 reader를 재설치하면 손상된 reader와 같은 내용을 가진 검증된 사본으로 복구할 수 있다. 호환되지 않는 snapshot은 수치를 임의로 재계산하지 않고 거부한다.

UI는 기존 clinical table 스타일의 `솔루션 관리` 대화상자다. 설치 필요/검증 중/설치 중/설치됨/복구 필요, 버전, 패키지 선택, 제거, 이전 버전을 제공한다. 설치 파일 검증 비용은 분석 timing의 `runtimeVerification`으로 별도 기록한다. 설치 progress마다 최근 결과 전체를 다시 조회하지 않는다.

최초 실행은 공용 파일을 저장소에 복사하므로 이후 실행과 구분해야 한다. 공용 준비 화면을 표시하고 모델 검증은 실행 직전으로 옮겼다. 전체 설치량이 줄어들거나 모든 시작이 즉시 완료된다고 주장하지 않는다.

실제 설치 시험에서 깊어진 경로의 `pydicom` import 실패를 발견했다. Windows의 확장 경로 형식을 Python dependency·adapter 탐색 경로에 적용해 해결했으며, 260자 초과 import 회귀 검사와 실제 CT/MRI CUDA 환경 로딩을 확인했다. 별도 검증기를 늘리지 않고 기존 4개 hash worker를 선택 설치에서도 재사용한다.

공용 reader에는 vendor 샘플 목록이 없다. CT/MRI 가져오기는 이 목록을 필수 파일로 요구하지 않으며, 샘플 증거가 없는 일반 입력에는 기존 HU·Water 확인을 요구한다. 명시적인 증거 없이 샘플로 간주하거나 확인을 생략하지 않는다. 이 경우의 실제 가져오기와 synthetic 회귀 검사를 추가했다.

## 운영자 재현 절차

기존 signed payload와 같은 profile/issuer를 사용한다. issuer 개인키와 model key는 운영자 저장소에만 둔다.

```powershell
# 1. 현재 앱 palette를 준비하고, 기존 검증된 전체 payload에서 새 선택 bundle 생성
npm run build:desktop
node scripts/security/selection-payload.cjs AUTHORITY SIGNED_PAYLOAD NEW_BUNDLE VERSION BUILD_PYTHON

# 2. 이 bundle의 정확한 실행 조합을 추출한 뒤 P2 관리 절차로 필요한 상품만 승인
node scripts/security/solution-admin.cjs bundle-executions AUTHORITY NEW_BUNDLE NEW_EXECUTIONS.json

# 3. licenseVersion: 3인 해당 profile build 정책으로 설치 후보 생성
node scripts/security/package.cjs internal dir BUILD_PUBLIC.json NEW_BUNDLE
# customer 설치 후보: customer dir / 정식 서명 설치 파일: customer nsis
```

`BUILD_PYTHON`은 배포 코드가 아니라 builder가 dependency metadata를 읽을 Python이다. 현재 검증 환경에서는 `work/modality-integration/envs/ct/Scripts/python.exe`를 사용했다.

설치 파일에는 공용 content와 서명 metadata만 넣는다. 전체 모델 bundle은 별도 NAS/폴더 배포 자료다. 사용자는 장비 활성화 후 `솔루션 관리 → 패키지 폴더 선택 → 선택 항목 설치·업데이트`로 진행한다. `components` 아래가 아니라 `catalog.json`이 있는 최상위 폴더를 선택한다. 단독 배포 media는 전체 component의 작은 서명/index metadata와 선택에 필요한 content를 포함하면 된다. 지원하는 정확한 선택은 signed catalog가 결정한다.

앱 실행 파일/설치 파일의 Windows code signing은 유지한다. 이미 issuer inventory로 봉인한 runtime executable은 포장 중 다시 서명해 바이트를 바꾸지 않는다. customer NSIS의 실제 인증서 요구와 완료 후 서명 확인은 유지된다.

## 검증 기록

- `npm run test:installations`: 단독·혼합 7가지, 공유 파일, 중단/복구, 실행 pin, 권한 회수, 제품별 rollback, 손상 격리, 공용 복구, 디스크/권한/잠금 오류.
- `npm run test:solution-security`: v3 JS/Python 일치, 실행 바꿔치기/recipe/구형 승인 거부, 확정 결과 보존.
- `npm run test:model-security`: 기존 9개 테스트. customer v3 fixture는 선택 manifest 및 설치 승인·동글 제거·회수까지 검사한다. synthetic hardware를 production attestation이 거부하는 검사도 유지한다.
- `npm run test:artifact-security`, `test_runtime_paths.py`, TypeScript, 언어/보간, Desktop build.
- 공용 standalone 환경에서 20개 dependency의 주요 import 성공, torch 미로드 확인.
- 보호된 실제 내부 설치본의 5개 route와 제거 후 열람 검증은 `scripts/security/validate-selected-electron.cjs`가 수행한다. 최종 실행 결과는 아래 완료 기록을 따른다.

```powershell
node node_modules/electron/cli.js scripts/security/validate-selected-electron.cjs `
  release/internal/win-unpacked/resources/app.asar NEW_BUNDLE INTERNAL_AUTHORITY SAMPLE_ENGINE_ROOT
```

시험은 별도 `outputs/selected-runtime-check/<uuid>`의 authority·CNG 장비·결과 저장소를 사용한다. 기존 운영/개발 license와 원본 입력을 수정하지 않는다. 이 폴더에는 private 자료가 있으므로 Git/고객 배포 대상이 아니다.

## 남은 실제 환경 검증과 범위

- 실물 YubiKey 5C NFC 5.8: 미도착. 실제 attestation·제거/재연결·다른 PC 거부는 실물 도착 후 검증한다.
- 실제 원격 HTTPS license 서버, 서명 인증서로 만든 customer NSIS, 새 PC의 5개 route: 이번 로컬 내부 시험으로 완료 처리하지 않는다.
- 인터넷 package catalog/download 서비스는 만들지 않았다. 현재 서명된 폴더/NAS media를 사용한다. 서버가 준비되면 전송 계층을 붙이고 다운로드 중단/재개 검증을 추가한다.
- P4 계정/OIDC, P5 결과 게시, P7 Web/태블릿은 별도 단계다. 웹에 업로드·분석 기능을 추가하지 않았다.
- 기존 결과를 위해 reader들을 보존하므로 업데이트 누적 시 공간이 증가한다. 참조 확인 없이 reader 폴더를 수동 삭제하지 않는다.

### 실제 설치본 완료 기록

실제 내부 `app.asar`의 main/preload/UI를 Electron 시험 harness로 실행했다. 이 PC의 RTX 3050 8 GiB, Windows CNG·DPAPI, 별도 QA authority를 사용했다. NSIS 설치 마법사나 운영 서버 시험과는 구분한다.

| 경로 | 실제 입력·출력 확인 |
| --- | --- |
| CT | 제공 NIfTI 1건 → GPU 추론 → 암호화 Mask → 32개 구조 측정 → 3방향 Overlay/slice → GLB와 3D 화면 |
| MRI | 제공 NRRD 1건 → GPU 추론 → 암호화 Mask → 28개 구조 측정 → 3방향 Overlay/slice → GLB와 3D 화면 |
| X-ray AP | 제공 NRRD 1건 → 방향 분류·GPU 추론 → 암호화 Mask → 6개 구조 측정·Overlay |
| X-ray LAT-LT / LAT-RT | 각각 제공 NRRD 1건 → 방향 분류·GPU 추론 → 암호화 Mask → 각각 11개 구조 측정·Overlay |
| MRI 후처리 | PP500·강화 후보의 Overlay/3D와 Raw Mask hash 보존, Raw 복귀 |
| 제거·회수 | 세 모델 제거 후 license 회수 → 5개 결과 열람 유지, 신규 설치는 `AUTHORIZATION`으로 차단 |

X-ray 3개 추론은 `p3-20261018-2`에서 완료했다. CT/MRI 샘플 목록 의존성을 수정한 `p3-20261018-3`에서는 CT/MRI만 다시 추론하고, X-ray는 기존 결과의 측정·Overlay·UI를 재검증했다. 원본 입력 hash 불변도 확인했다. 최종 Mask의 기존 버전과의 voxel 단위 비교나 임상 정확도 검증은 이번 범위가 아니다.

실행 증거는 Git에서 제외한 `outputs/selected-runtime-check/785af919-05cd-48d4-b000-7f73c20354ed/verification.json`, `analysis-samples.json`과 화면 캡처에 있다. `analysis-samples.json`의 `previousReport`가 최초 X-ray 실추론 기록을 가리킨다.

해당 실행에서 3개 선택의 업데이트·전체 검증은 265.84초, 분석 실행 전 runtime 검증은 CT 11.34초, MRI 6.08초, AP 9.46초, LAT-LT 9.92초, LAT-RT 11.81초였다. 반복 benchmark가 아니라 이 설치 시험의 단일 관측값이며, 추론 단계 시간에 합쳐 표기하지 않는다. 최초 설치 복사 비용과 warm 시작도 별도로 취급한다.

최종 빌드를 다시 만든 뒤 `validate-selected-reopen.cjs`로 모델·QA CNG 키가 없는 상태에서 재시작했다. 5개 결과의 구조 ID·voxel 수·측정값이 저장된 값과 정확히 같았고, Overlay와 GLB를 열었다. 정상 재시작은 3.25초였다. 이어 `--repair-common`으로 **이 QA 저장소만**의 공용 adapter를 손상시키고 다시 실행했다. 서명된 번들로 자동 복구한 시작은 34.15초였고, 5개 결과 및 연속 slice/Overlay의 worker 재사용 검사가 모두 통과했다. `reopen-verification.json`과 `repair-verification.json`에 기록했다. 두 수치는 같은 PC·시험 harness의 단일 실행값으로, 새 PC·최초 설치의 성능 보장이 아니다.

```powershell
node node_modules/electron/cli.js scripts/security/validate-selected-reopen.cjs `
  release/internal/win-unpacked/resources/app.asar outputs/selected-runtime-check/QA_UUID
# 위 시험 전용 저장소의 공용 파일을 손상시킨 뒤 복구까지 검사할 때만 추가:
# --repair-common
```

# Desktop 근육 분석 통합 작업 계획

기준: 2026-09-27 사용자 전달 패키지 및 현재 `design/marimo-glass` 작업 트리.
사용 대상은 의료진이다. Desktop에서 분석하고 Web은 허용된 결과만 조회한다.
현재 navy / glass / Pretendard 디자인과 기존 27개 데모 segment 색상은 유지한다.

실행 결과와 지원 경계: [모델 통합·검증 기록](EXMO_MODALITY_VALIDATION_2026-09-27.md). 아래는 구현 전에 정한 순서와 판정 기준이다.

## 1. 전달본 검토 결과

| 작업 | 입력 계약 | 실제 출력 | 먼저 해결할 문제 |
| --- | --- | --- | --- |
| CT thigh | 물리 affine·mm·HU 근거가 있는 3D CT. 전달 CLI는 샘플 manifest에 묶여 있음 | 33 labels(배경 포함), native mask, cm³, HU, HU fat-range fraction | MONAI 1.3.2 고정, Windows 원자적 저장 호환, 신규 입력 adapter, 큰 native probability 배열의 메모리 |
| MRI thigh | Water 3D scalar NRRD | 29 labels(배경 포함), raw/PP500, cm³, entropy, TTA disagreement | Windows 저장 호환, Water 입력 확인, 128³ FP32/TTA 실행 및 메모리 |
| X-ray AP | 기존 분류기가 AP로 판별한 지원 2D 영상 | 7 labels(배경 포함), source-grid mask, 투영 면적 cm² | 전처리·원본 방향 복원 계약 보존, 입력 spacing 확인 |
| X-ray LAT-LT/RT | 기존 분류기의 해당 측면 판별, 지원 2D 영상 | 각 12-label schema, 5-fold/mirroring, cm², component QC | Linux `fcntl` 의존성 분리, GPU 누적 메모리(기존 peak 약 13.33 GiB), 8GB 실행 검증 |

- CT 실제 5건, MRI 실제 5건(raw/PP500은 같은 5건), X-ray 15건(AP 5, 좌·우 측면 5쌍).
- CT/MRI 원본 label은 좌우 공통이다. 현재 물리 좌표·양측 대퇴골 기준으로 좌우 측정/표시를 추가했으며, 붙은 성분이나 기준이 불충분한 경우 미분류로 남긴다. 새 결과에 데모의 가상 L/R 측정값을 연결하지 않는다. 세부 범위는 위 검증 기록을 따른다.
- MRI Water 단독에는 지방침윤 값이 없다. CT fat-range 비율, MRI entropy, X-ray 투영 면적을 같은 지표로 합치지 않는다.
- X-ray 측면의 전달본 자체도 두 실행 간 193~338 pixel 차이가 있다. 재현성 차이와 정답 대비 정확도를 구분한다.
- CT/MRI의 POSIX `renameat2`/directory fsync, X-ray의 `fcntl`을 Windows에서 그대로 실행할 수 없다. 모델 알고리즘과 파일 저장 호환 처리를 분리해야 한다.
- 전달 원본·가중치·샘플·Mask는 수정하거나 Git/Web에 넣지 않는다. 앱에 연결한 결과를 새 추론으로 위장하지 않는다.

## 2. 구현 순서

### A. 패키지와 실행 환경 확정

1. archive SHA-256 및 내부 manifest를 검증하고 `work/`의 비공개 복사본에만 준비한다.
2. 서로 충돌하는 CT/MRI/AP/LAT 의존성을 별도 Python 환경으로 고정한다. 원본 저장소 환경을 변경하지 않는다.
3. Windows 저장 호환은 파일 overwrite 방지·원자적 완료·실패 결과 격리를 보존한다. 추론/측정 식은 제공 함수를 우선 사용한다.
4. GPU 작업은 한 번에 하나만 실행한다. 장치/정밀도/TTA/후처리/버전을 결과에 기록한다. OOM 시 해상도·fold·TTA를 몰래 바꾸지 않는다.
5. 모달별 실제 샘플을 실행해 원본 결과의 label/geometry/측정과 비교한다. 8GB 조정이 필요한 경로는 별도로 비교 결과를 남긴다.

### B. 의료진 작업 화면과 입력 준비

1. 첫 화면을 간결한 **분석 작업 목록**으로 교체한다. 인사형 질문·큰 선택 카드·장식 대신 분석명, modality, 지원 protocol, 입력 및 실행 상태를 표시한다.
2. 작업을 먼저 선택한 뒤 파일/폴더를 가져온다. 환자·Study·Series 정보와 입력 검증 상태, 선택 목록, 영상 viewport를 같은 작업 공간에서 확인한다.
3. DICOM은 UID와 실제 위치/방향 정보를 기준으로 묶는다. 서로 다른 Series를 파일명으로 합치지 않는다. 지원하지 않는 프레임·불균일 geometry는 명시적으로 보류한다.
4. NRRD/NIfTI는 header/affine/mm를 읽고 지원하는 scalar 영상만 받는다. detached 외부 파일 경로, 손상 header, 비정상 차원은 차단한다.
5. CT HU 또는 MRI Water가 파일만으로 확인되지 않으면 확인 상태를 유지하고 분석 조건을 충족하기 전 실행하지 않는다. 모달리티 선택 자체를 영상 검증으로 간주하지 않는다.
6. Hover preview·고정 preview·분석 선택을 분리한다. 볼륨은 axial/sagittal/coronal 및 slice 스크롤을 제공하고 물리 방향 표시를 검증한다. X-ray는 2D 원본 방향을 유지한다.
7. 최종 검토에서 우클릭/선택 제외 후 실행한다. 다른 작업으로 이동해도 입력 목록·선택·진행 상태를 유지한다.

### C. 추론, 결과 및 기존 뷰어 연결

1. Main process가 입력 snapshot/opaque ID/작업 소유권을 관리한다. Renderer는 임의 경로·명령·Mask bytes에 접근하지 않는다.
2. X-ray classification → 맞는 AP/LAT 모델, CT/MRI는 확인한 입력 계약 → 해당 모델로 전달한다. 불확실/미지원/Parts를 강제로 통과시키지 않는다.
3. 실행·대기·취소·실패·완료 상태를 구분한다. 늦은 응답은 새 작업을 덮어쓰지 않고, 완료 표시 전 산출물·geometry·측정의 일관성을 검사한다.
4. 결과는 제공된 실제 class 이름과 측정 단위로 표시한다. class 선택 시 source와 일치하는 Overlay를 표시하고 QC/TTA 정보는 상세 영역에서 확인한다.
5. CT/MRI 3D 표면은 실제 native mask에서 파생하고 원래 voxel geometry와 연결한다. 기존 데모의 ID 숫자를 새 ontology에 재사용하지 않는다. 같은 해부학적 이름의 기존 색상은 보존한다.
6. 원본 Mask는 내부 산출물로만 보관한다. 화면에는 필요한 합성 preview/허용 geometry/측정값만 제공하며 임의 파일 제공·Mask 다운로드 경로를 만들지 않는다.
7. 기존 데모 동작과 실제 분석 결과를 분리한다. 새 모달에서 제공하지 않는 좌우/지방 지표/3D 체적을 데모 데이터나 0으로 채우지 않는다.

## 3. 완료 판정

- SHA 검증, checkpoint strict load, 실행 recipe와 샘플 결과 비교 보고서.
- 입력 형식·DICOM 그룹·affine·좌우/상하 표시·slice 변경·Overlay 정렬 검사.
- class별 voxel/pixel count와 cm³/cm²의 독립 재계산, empty/missing/null 단위 처리.
- 취소/재시도/동시 실행 차단/잘못된 입력/오래된 preview/원본 보존/완료 결과 보존 검사.
- Web에 Desktop import/IPC/model/Mask 경로가 포함되지 않는지 확인.
- 기존 `npm test`, 타입 검사, 실제 Electron 동작·성능·27색 회귀 확인.
- 실제 Desktop 창의 기본 크기와 작은 크기에서 작업 목록·입력·검토·결과를 확인하고 빌드 실행본을 연다.

## 4. 범위 경계

회원·서버 동기화·Web 분석 기능·모델 재학습·새 지방침윤 산식·정답 없는 정확도 점수는 이번 연결 작업에 추가하지 않는다.
다중 검사 비교의 기존 요구는 유지하되, 서로 다른 ontology/단위 또는 미분리 좌우를 자동 대응시키지 않는다.
환경·입력·제공 모델 때문에 미검증인 경로는 완료로 표시하지 않고, 실제 실행 결과와 함께 기록한다.

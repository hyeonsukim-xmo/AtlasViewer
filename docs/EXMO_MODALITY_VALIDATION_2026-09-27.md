# EXMO Desktop 모델 통합 · 검증 기록

작성: 2026-09-27. 대상: `design/marimo-glass` 작업 트리. 이 기록은 임상 성능 인증이 아니라 실제 연결·재현·회귀 검증 범위다.

## 구현한 흐름

의료진용 분석 작업 목록 → CT/MRI Water/X-ray 작업 선택 → 영상·Series 등록/미리보기 → 체크한 영상 검토 → 명시적 Segmentation 실행 → 실제 값·Overlay·CT/MRI 3D → 로컬 결과 재열기/최대 3개 비교.

- 기존 navy/glass/Pretendard 스타일, EXMO 로고와 27개 segment 색상을 유지한다. 과도한 시작 카드와 질문형 문구를 제거했다.
- DICOM은 Study/Series UID와 공간 좌표로 묶고 정렬한다. SeriesDescription이 같다는 이유로 합치지 않는다. 입력은 앱 소유 복사본으로 처리한다.
- CT/MRI는 physical LPS 기준 axial/coronal/sagittal reslice를 제공한다. 영상은 linear, label은 nearest-neighbor로 같은 reference grid에 합성한다. Preview에는 patient orientation을 표시한다.
- 결과는 실제 native label count와 affine determinant/spacing에서 독립 재계산한 값이 패키지 metrics와 맞아야 게시한다. 원본 Mask가 renderer/다운로드/API에 전달되는 경로는 없다.
- CT/MRI mesh는 native mask에서 생성한 표시용 표면이다. LPS `(x,y,z)`를 Three `(x,z,-y)`로 변환한다. 표면 단순화는 표시용이며 부피 계산에는 사용하지 않는다.
- 앱은 저장소별 단일 인스턴스로 실행한다. 중복 실행은 기존 창을 활성화하며 같은 저장소를 다시 열지 않는다. 한 번에 하나의 추론 job을 실행하고 별도 preview worker가 화면 응답을 담당한다. 취소 시 해당 Python process tree를 종료하며 부분 결과를 게시하지 않는다. 이전 완료 결과는 보존한다.
- 3개 결과는 각기 독립된 scene/state를 사용한다. 활성 검사 opacity, exploded class 대응, 개별 우클릭 회전, 배경/선택 해제 시 복귀를 제공한다. 각 view는 독립 fit하며 자동 정합이나 동일 배율 비교를 주장하지 않는다.
- MRI raw/PP500을 구분해서 열 수 있다. PP500은 제공된 후보 후처리이며 개선된 정답으로 취급하지 않는다.

## 제공 패키지와 실행

원본 위치: 사용자가 제공한 `260927` 폴더. ZIP/TAR와 내부 payload SHA-256 검증을 모두 통과했다. 원본 NAS 파일과 vendor 코드/weights는 수정하지 않았다.

| 패키지          | 실제 연결한 recipe                                                                                               | 출력 해석                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| CT              | 단일 UNETR, MONAI 1.3.2, FP32 CPU, Gaussian SW, TTA_NONE, PP_NONE, probability physical inverse 후 native argmax | 32 foreground class, cm³, HU 평균, −190~−30 HU fat-range 비율                |
| MRI             | full6 UNet, MONAI 1.5.1/Torch 2.9.1, FP32, identity+L/R flip TTA, raw 및 PP500                                   | 28 foreground class, cm³, normalized entropy, TTA disagreement, component QC |
| X-ray AP        | 제공 VNet/MONAI recipe, native grid 복원, TTA 없음                                                               | 6 foreground class, projection cm², 3D 체적 없음                             |
| X-ray LAT-LT/RT | 제공 nnU-Net, 각 5 folds, mirroring 유지, CPU accumulation                                                       | 11 foreground class 정의, 일부 reserved class, projection cm²                |

Windows 호환 처리는 `desktop/model-runner.py`에 제한했다. MRI binary read의 `O_BINARY`, 재파싱 지점을 거부하고 경로/파일을 잠그는 NRRD reader, Windows no-replace/write-through 결과 게시, 출력 파일 fsync를 이식했다. Model forward·전처리·TTA·후처리 조건을 줄이지 않았다. CT native probability는 disk-mapped 저장과 slice 단위 정규화를 사용한다. 동일 probability를 원본 inverse와 새 inverse에 넣었을 때 voxel-exact 동등성을 검사한다.

실행 환경: Windows, RTX 3050 8 GB, system RAM 32 GB. 기존 사용자 앱이 사용 중인 상태에서 실행했다. CT는 제공 CPU recipe, MRI/AP/LAT는 CUDA로 검증했다. 아래 시간은 모델 프로세스 시작부터 결과 저장까지이며 첫 import/warmup·동시 OS 부하에 따라 변한다. UI surface 생성 시간은 별도다.

| 실제 재추론 sample | 처리 시간 | 원본 제공 결과와 다른 voxel/pixel |  전체 대비 |
| ------------------ | --------: | --------------------------------: | ---------: |
| CT EXMO_CASE_001   |   715.5 s |                    1 / 48,496,640 | 0.0000021% |
| MRI sample_01      |    64.5 s |                    40 / 6,742,848 | 0.0005932% |
| MRI sample_02      |    69.0 s |                    66 / 7,477,650 | 0.0008826% |
| MRI sample_03      |    64.9 s |                    37 / 6,742,848 | 0.0005487% |
| X-ray AP_01        |    57.1 s |                  552 / 19,942,780 | 0.0027679% |
| X-ray LAT_LT_01    |   197.7 s |                  277 / 22,862,532 | 0.0012116% |
| X-ray LAT_RT_01    |   161.9 s |                  242 / 22,862,532 | 0.0010585% |

**완전한 cross-platform voxel 일치를 주장하지 않는다.** 제공 기준 결과는 다른 Linux/GPU/CPU 환경에서 생성되었다. 위 차이는 수치 재현 차이이며 정답 대비 오류율·Dice·임상 정확도가 아니다. 다른 sample 전부를 이 장비에서 재추론했다고 표시하지 않는다. 모델 release 허용오차나 임상 사용 승인은 별도 근거로 정해야 한다.

## 자동 검사

1. `npm test`: 기존 GLB hash/27개 색상·selection/group·Explode layout·회전 복귀·hover side·camera 회귀.
2. `npm run test:desktop`: 실제 Electron에서 중복 실행 종료, sandbox/static asset 경계와 idle/minimized 0 render, 약 10 ms median frame interval(100 Hz 환경), 기존 조작 검사.
3. `npm run test:classifier`: 합성 DICOM/NRRD의 label/score를 원본 API와 비교. CT/3D/blank/corrupt/detached 입력 거부.
4. `npm run test:imaging`: 비대칭/oblique phantom의 physical views와 Overlay grid, mm/coded affine, detached NRRD 거부, 4개 Study/Series 분리, 섞인 파일 순서 복원, HU rescale 1회, duplicate/gap 거부, 기존 결과 no-overwrite, CT inverse 동등성.
5. `validate-imaging.py --results`: 위 실제 model output의 shape·geometry·class count·cm³/cm² 재계산, 실제 overlay와 surface 생성, 원본 결과 차이 기록.
6. `validate-imaging-desktop.cjs`: 실제 IPC/worker/화면에서 불투명 파일 ID·slice/방향 전환·CT surface·MRI 3개 대응 구조·독립 회전·PP500·추론 취소/재실행·동시 추론 차단·원본 보존·Web 분리 검사. File picker만 테스트 입력으로 바꾼다.

개발 경로와 `release/win-unpacked/resources/app.asar` 패키지 경로 모두에서 Desktop 검사를 실행했다. Python adapter와 기존 색상 정의에서 생성한 palette는 `resources/imaging`으로 함께 배포한다. Python이 Electron의 ASAR 내부 파일을 직접 읽는 경로는 사용하지 않는다. 패키지 경로에서도 실제 AP 추론과 취소 후 재실행을 통과했다.

이 PC의 앱 저장소에는 위 7건의 **실제 재추론 결과**를 등록했다. Study 설명에 제공된 검증 샘플임을 표시하고, 분석 일시는 각 추론 완료 파일의 실제 저장 시각을 사용한다. 테스트 fixture의 고정 시각이나 가상 측정값은 사용하지 않는다. 원본 Mask는 앱 내부에 유지한다.

상세 JSON/화면 캡처는 비공개 `outputs/imaging-check/`, 기존 GPU 회귀는 `outputs/desktop-check/`에 있다. 생성된 테스트 데이터와 실제 분석 데이터는 Git에 넣지 않는다.

## Viewer 성능 수정 · 2026-09-27

Slice/Overlay 입력에 걸린 110 ms trailing debounce 때문에 연속 스크롤 중에는 영상이 갱신되지 않았다. Viewport당 한 요청만 처리하고 다음 대기 요청을 최신 위치로 교체하도록 수정했다. 다른 case/view/class에 대한 늦은 응답은 표시하지 않는다.

- 같은 CT에서 30회 연속 스크롤: 조작 중 갱신 0회 → 29~30회, 최종 slice 정확히 30장 이동.
- CT Overlay IPC 중앙값 33 ms → 21 ms. MRI 세 케이스 반복 요청의 worker 처리 약 60~~80 ms → 5~~6 ms, IPC 포함 중앙값 11 ms. 이 PC·제공 샘플의 관측값이며 모든 영상의 보장값은 아니다.
- Overlay opacity 21회 연속 변경 중 21회 갱신. 최대 6개 영상 객체·512 MiB의 LRU로 영상/Mask 재로딩을 줄였다. PNG 압축 수준만 낮추고 영상 해상도·픽셀·label·좌표·측정값은 바꾸지 않았다.
- `npm run test:imaging`에서 3개 물리 방향, oblique 영상, 색상/opacity/선택 합성 픽셀 일치와 cache 제한을 검사한다. `npx electron scripts/validate-viewer-performance.cjs`는 실제 스크롤·opacity·느린 응답의 요청 병합·오래된 방향 응답 차단·3D idle을 검사한다. 비공개 측정 기록은 `outputs/imaging-check/viewer-*.json`이다.

## 비교·조작 수정 및 강화 후처리 후보 · 2026-09-27

- Overlay는 선택한 class 목록을 한 번에 합성한다. 빈 목록은 Overlay 없음, `null`은 전체 class다. 처음에는 전체 선택이며 표 왼쪽 헤더 체크박스로 전체 선택/해제하고, 구조 행의 이름·값·여백을 눌러 개별 선택을 바꾼다. 일부 선택은 헤더에 중간 상태로 표시한다. label 번호가 아닌 semantic ID로 검사 간 구조를 연결한다. Overlay 표시 선택과 3D 강조/회전 선택은 별도로 유지한다.
- 측정 패널 오른쪽 구분선을 드래그하거나 키보드 좌우 방향키로 너비를 조절한다. 두 번 클릭하면 기본 너비로 돌아간다. 패널은 최소 280 px, 영상 영역은 최소 320 px이며 창 축소 시 자동 제한한다. 같은 결과의 측정/QC·2D/3D 전환에서 너비를 유지하고 3D canvas도 영역 크기에 맞춘다.
- 조립 상태의 근육 클릭은 첫 클릭부터 모든 비교 검사에서 같은 근육을 강조한다. 복수 선택을 유지하며, Explode/Assemble과 그룹은 모든 검사에 함께 적용한다. Explode 구조 선택은 대응 구조만 표시하고 우클릭 회전은 각 검사에서 독립적으로 동작한다. 미검출 구조를 선택해도 다른 근육을 대신 강조하지 않는다.
- 측정값과 QC는 최대 3개 검사 열로 나란히 표시한다. 검사마다 MRI variant를 바꿀 수 있고, 방향·slice·opacity를 유지한다. 가운데 버튼을 누른 채 4 px 수직 이동할 때 1 slice 이동하며 범위를 넘지 않는다. 뒤로 가기는 테두리가 있는 명시적인 버튼이다.
- CT/MRI 공통 구조 색상을 대조했고 유일하게 달랐던 iliacus를 MRI의 `#B2D4F2`로 통일했다. 기존 저장 결과에도 적용한다. 기존 데모 27개 색상/GLB는 그대로다.
- 사용자 승인으로 `strong` 검토 후보를 추가했다. 제공 MRI `PostprocessingRecipe`와 `apply_postprocessing`을 그대로 호출한다. 6-connectivity, foreground 전체의 500 mm³ 미만 제거, 근육 label **1–23**에만 큰 성분 **최대 2개** 제한. 몸통·뼈 **24–28**에는 개수 제한을 적용하지 않는다. 좌우 판정이나 FOV 상단 자동 절단을 하지 않는다.
- 후보 Mask·metrics·mesh는 별도 폴더에 보관하며 Raw/PP500 및 vendor 파일을 수정하지 않는다. Raw hash·recipe·class별 제거 voxel 수를 내부에 기록한다. native geometry에서 체적·component·entropy를 다시 계산하고 표에 Raw 값과 감소량을 표시한다. renderer에는 Mask 파일/배열을 전달하지 않는다.
- TTA **1.16% 초과**는 사용자가 조절할 수 있는 검토 기준이다. 해당 검사에서 **강화 후보 비교**를 제공하며 자동 정답 판정이나 Raw 덮어쓰기를 하지 않는다. 후처리로 원래 추론의 TTA disagreement를 낮춰 표시하지 않는다. 최대 2성분 규칙은 분리된 정상 부분을 제거하거나 큰 오검출을 남길 수 있으므로 검토용이다.
- `npm run test:imaging`: 복수 Overlay 픽셀 합성, 정확히 500 mm³인 성분 유지, 작은 성분 제거, 근육 2성분 제한/몸통 예외, Raw hash 보존, geometry·체적·entropy 재계산을 검사한다. `validate-imaging-desktop.cjs`에 실제 가운데 버튼 드래그, 세 검사 측정/QC 열, 첫 canvas 클릭, 전체 Explode/독립 회전, 실제 강화 후보와 slice 유지, X-ray 복수 Overlay 및 뒤로 가기를 포함한다.
- 최종 `app.asar` 검사 통과: 위 비교 동작, 900 px 폭의 QC 열, 실제 AP 취소·재추론, renderer 오류 0건. 성능 재검사에서 연속 wheel 30회 중 30회 갱신, CT preview IPC 중앙값 22 ms, MRI 3-case 9 ms, 3D idle render 0회를 관측했다. 기록은 비공개 `desktop-report.json`, `viewer-comparison-packaged.json`이다.

## 환자 좌우 측정·Overlay·3D 연결 · 2026-09-27

- CT/MRI 원본 class ID는 좌우 공통이다. 양측 대퇴골의 분리 성분과 영상의 origin·direction·spacing을 환자 LPS 좌표로 변환해 기준면을 추정한다. Raw의 기준면을 PP500·강화 후보에도 동일하게 적용한다. 파일 배열의 가운데나 화면 좌우로 판단하지 않는다.
- 각 연결 성분이 기준면 한쪽에 충분히 위치할 때만 Left/Right로 배정한다. 붙어 있는 양측 구조, 정중앙 구조, 대퇴골 기준 부족·기울기 불안정은 미분류로 남긴다. 이 방식은 자동 검토 후보이며 분리 정확도가 검증된 모델을 대신하지 않는다.
- native voxel 수로 좌·우·미분류 체적(cm³)을 계산하고 합계가 기존 체적과 정확히 일치하는지 확인한다. 양쪽 검출 및 미분류 0일 때만 `|L−R| / mean(L,R) × 100`을 표시한다. 촬영 범위가 다른 검사끼리의 체적 차이는 전신/전체 근육의 차이를 의미하지 않는다.
- 표는 총 체적·entropy/fat-range·후처리 제거량만 간결하게 표시하며 개별 행 체크박스는 두지 않는다. 제거량에 마우스를 올리면 Raw 체적과 단위를 확인할 수 있다. 행 전체 클릭/구조 이름 버튼으로 선택하고, 헤더 왼쪽 체크박스로 전체 선택한다. 좌우 값·차이는 3D hover에서 가리킨 쪽을 먼저 보여준다.
- 좌우/미분류 surface를 class별 하나의 geometry·pivot으로 묶어 선택·Explode·우클릭 회전한다. 좌우의 상대 위치와 원래 크기를 유지하고 class 순서로 배치한다. 선택한 class가 하나이면 해당 viewport의 빈 공간에서도 우클릭 드래그로 양쪽을 함께 회전한다. 검사 간 대응 class를 함께 선택하되 회전은 검사마다 독립적이다. 원본 class 색상은 그대로다.
- 파생 좌우 Mask와 surface만 앱 비공개 저장소에 추가한다. 원본 Mask·Raw/PP500 metrics·entropy·QC는 변경하지 않는다. 기존 결과는 처음 열 때 같은 variant로 준비하며, 다른 variant 선택 시 그 variant의 실제 체적을 다시 사용한다. renderer에는 좌우 Mask 경로나 배열을 전달하지 않는다.
- `npm run test:imaging`에서 편향된 FOV·이동 origin·축 반전/순열·oblique geometry·단측 대퇴골·붙은 성분·HU/entropy·체적 보존·좌우 Overlay 합성을 검사한다. Electron 검사에는 간결한 표·체크박스 없는 행 선택·class 쌍 선택/해제·hover 순서·빈 공간에서 양측 회전·검사별 독립 회전·홈의 작업/최근 결과 행 열기·원본 SHA-256 보존을 포함한다. 비교 체크박스가 있는 결과 목록은 행 전체 클릭으로 비교를 선택/해제하며 명시적인 결과 열기 버튼만 Viewer를 연다. 버튼은 비교 선택을 변경하지 않고, 행/체크박스 모두 최대 3개와 X-ray AP/LAT class 구성 제한을 동일하게 적용한다.
- sample_01 PP500 sartorius 재확인: native Mask 좌 4,585 voxel = 102.8006 cm³, 우 7,131 voxel = 159.8847 cm³, 미분류 0. 차이 57.0841 cm³ / 양측 평균 = 43.4619%. 렌더링 surface의 체적도 각각 약 101.04 / 158.01 cm³로 같은 차이를 보인다. 이는 분할 결과의 체적 비교이며 화면에서 비슷해 보이는 길이나 임상 분할 정확도의 판정이 아니다. 측정값이나 후처리 Mask를 화면 모양에 맞춰 바꾸지 않았다.
- sample_01 원인 대조: Raw부터 좌 103.3388 / 우 160.5349 cm³이고 PP500은 각각 0.5381 / 0.6502 cm³만 제거했다. PP500의 독립적인 두 연결 성분 체적은 앱의 좌우 수치와 정확히 일치하며 반대쪽으로 배정된 voxel은 0이다. 양쪽이 검출된 113개 axial slice 중 108개에서 우측 Mask 면적이 더 크다. 전체 차이 57.0841 cm³ 중 55.7836 cm³는 공통 slice 면적 차이, 1.3004 cm³는 우측에만 남은 끝부분이다. 예: native slice 53은 우 5.5305 / 좌 3.5375 cm², slice 75는 우 4.0856 / 좌 2.4912 cm². 촬영 범위/길이 차이보다 예측된 단면적 차이가 주된 원인이다.
- 제공된 MRI baseline의 sartorius Mask와 현재 재현 결과는 1 voxel(0.0224 cm³)만 다르며, TTA 전 identity 예측도 좌 108.6301 / 우 157.7547 cm³로 이미 비대칭이다. 따라서 Viewer 좌우 분류·체적 계산·PP500이 새로 만든 큰 차이는 아니다. 원본 Water 영상과 Raw/PP500 Overlay를 대조했지만 해당 샘플의 독립적인 정답 annotation은 제공되지 않아 실제 해부학적 차이와 분할 오차의 비중을 확정할 수 없다. 모델 출력의 비대칭을 정상/질환 또는 임상적 차이로 판정하지 않는다. tooltip은 분할 체적과 양측 평균 대비 차이임을 표시한다. 비공개 대조 기록: `outputs/imaging-check/sartorius-review/report.json`, `axial-raw-pp500.png`.
- 중앙 기준면 독립 재검증: 앱의 좌우 계산 함수를 호출하지 않고 실제 저장된 sample_01 PP500 원본 Mask·좌우 Mask·NRRD LPS geometry·GLB를 읽어 대조했다. Sartorius는 원래부터 2개의 분리 성분이며 좌 4,585 / 우 7,131 voxel 각각이 원래 성분 전체와 정확히 일치했다. 전체 11,716 voxel에서 누락·중복·반대쪽 혼입 0. 저장된 기준면과 가장 가까운 voxel도 좌 39.4367 / 우 34.5617 mm 떨어져 있어 기준면이 해당 근육을 가르지 않는다. 영상 기하학적 중앙선, LPS X=0, 저장 기준면의 ±10/±20 mm 이동으로 voxel을 독립 분류해도 모두 동일하며, 양측 대퇴골이 있는 111개 slice에서 각각 직접 구한 중점으로 분류해도 동일했다. 기준면과 slice별 대퇴골 중점의 최대 차이는 4.6117 mm로, 해부학적 정중면의 완전한 일치를 증명하는 검사는 아니다. 해당 구조에서 기준면 오차가 체적 비대칭을 만든 가능성을 배제하는 검사다. 원본 영상/Mask hash 불변, GLB 좌우 이름·위치·체적 일치도 확인했다. 실제 기준면과 좌우 영역을 표시한 비공개 증거: `outputs/imaging-check/sartorius-review/midline-proof.png`, `midline-proof.json`; 재현 스크립트: `work/modality-integration/verify-sartorius-midline.py`.
- 전달 원본과 화면까지 추적: NAS의 `EXMO_MRI.tar.gz`를 직접 읽은 `samples/sample_01/pp500/metrics.json`에도 `top_component_volumes_ml`이 `[159.9071366732219, 102.80064801552474]`로 기록되어 있었다. 앱의 좌우 처리 이전부터 존재하는 예측 결과 차이다. 실제 저장 결과의 격리 복사본으로 최종 app.asar를 실행해 렌더러가 받은 GLB SHA-256과 원본 게시 mesh가 동일함을 확인했고, 양쪽 hover가 각각 해당 원본 수치 102.8 / 159.9를 표시하는 것도 확인했다. 실제 Mask의 정면 투영 면적은 좌 109.386 / 우 134.598 cm², 그 투영 영역을 통과하는 평균 두께는 좌 9.398 / 우 11.879 mm였다. 같은 배율·같은 window의 native 영상/경계 확대 대조 자료를 만들었으나, 이 검사들은 분할 경계가 해부학적으로 정확하다는 검증을 대체하지 않는다. 원본 영상/Mask 및 실행 앱의 임상 값은 수정하지 않았다. 비공개 기록: `boundary-closeup.png`, `boundary-review.json`, `ui-data-check.json`, `projections.json` (모두 `outputs/imaging-check/sartorius-review/`).
- 원영상 경계 추가 검토: sample_01 sartorius가 존재하는 native slice 5–124의 120장 전체를 동일 window·물리 배율의 원영상/예측 경계로 육안 대조했다. 37·59·81·89·93·97·103번은 Mask를 표시하지 않은 확대 영상도 별도로 확인했다. 우측 해당 영역이 더 두껍게 보이는 구간이 있지만, 85–102번의 좌측 예측은 특히 얇고 인접 조직과의 원영상 경계가 흐려 과소분할 가능성을 배제할 수 없다. 93번의 예측 면적은 좌 11 voxel = 0.5481 cm² / 우 41 voxel = 2.0428 cm²이다. 이 관찰은 독립적인 수동 분할이나 전문의의 경계 승인이 아니며 43.5%를 실제 근육량 차이로 검증한 결과가 아니다. 중앙선 수정이나 PP500 성분 제거로 해결되는 문제로 판정하지 않았다. 비공개 자료: `all-slices-01.png`–`all-slices-10.png`, `slice-093-boundary-review.png`, `native-regions-*.png`, `equal-scale-projections.png`; 재현 스크립트: `review-all-sartorius-slices.py`, `review-native-regions.py` (`work/modality-integration/`). 앱·원본 영상·Mask는 변경하지 않았다.
- 비교 행 수정 배포본 검증: 행/체크박스/키보드 선택·해제, 결과 열기 후 기존 비교 선택 유지, 빠른 복수 클릭, 최대 3개, X-ray AP/LAT 혼합 제한을 실제 Electron에서 통과했다. `npm run check`, `npm test`, 설치본 빌드 통과. CT/MRI preview IPC 중앙값 21/9 ms, wheel 30장 이동·30회 갱신, 3D idle render 0회, renderer 오류 0건. 비공개 기록: `viewer-comparison-row-packaged.json`.
- 쌍 선택/UI 수정 검증 통과: 구조 행 클릭·키보드 선택, 개별 체크박스 없음, 전체선택/패널 너비 유지, 좌우 hover 정보 유지, 한쪽 클릭 시 쌍 전체 해제, 빈 공간 우클릭으로 양쪽 동시 회전 및 다른 검사 불변. 최종 배포본에서 wheel 30/30회 갱신, CT preview IPC 중앙값 23 ms / MRI 3검사 8 ms, 3D idle render 0회. 기존 데모의 GPU·선택·애니메이션 검사도 통과했다. 비공개 기록: `desktop-report.json`, `viewer-paired-compact-packaged.json`, `outputs/desktop-check/`.
- 후처리 범위: MRI는 Raw / PP500 / 강화 후보가 연결돼 있다. CT는 제공 recipe의 `PP_NONE` 그대로이며 이번 좌우 배정은 잘못된 segmentation을 삭제하거나 보정하는 후처리가 아니다.
- 실제 저장 결과 CT 2건·MRI 3건에 같은 variant로 좌우 정보를 준비했고 원본 영상·Mask·metrics·entropy·QC 해시 보존을 확인했다. 좌우 분리 배포본 성능 검사: 연속 wheel 30장 정확히 이동, 조작 중 29회·전체 30회 갱신, CT IPC 중앙값 25 ms / MRI 3검사 8 ms, 3D idle render 0회. 기록은 비공개 `laterality-migration-backup/report.json`, `viewer-laterality-packaged.json`이다.

## 남아 있는 정확한 경계

- CT/MRI 좌우 배정은 양측 대퇴골과 물리 좌표 기반의 보수적 추정이다. 한쪽만 촬영되거나 성분이 이어진 경우 미분류가 남는다. 해당 부위에 가상 L/R 값이나 차이를 채우지 않는다.
- CT fat-range 비율은 PDFF/보편적 지방침윤율이 아니다. MRI Water-only와 X-ray에는 새 FI 산식을 추가하지 않는다. Entropy·분류 vote는 보정된 환자별 신뢰도나 정확도가 아니다.
- X-ray DICOM은 preview/분류까지 지원한다. 제공되지 않은 DICOM segmentation 검증과 AP 비표준 방향 복원은 통과시키지 않는다. 직접 분석에는 제공 recipe와 같은 NRRD를 사용한다.
- CT/MRI DICOM 경로는 합성 geometry/rescale 검사로 검증했다. 실제 의료기관별 압축·enhanced/multiframe·비균일·shear·stitching·프로토콜 적합성은 포괄 검증하지 않았다. 지원 밖 입력은 거부한다.
- MRI는 Water 확인을 요구한다. CT는 HU 근거가 없으면 명시적 입력 단위 확인을 요구한다. 사용자 확인은 독립적인 modality/HU 검증으로 위장하지 않는다.
- MRI package가 기록한 상복부/체외 false positive 및 class support 한계는 남아 있다. 강화 후보는 사용자가 선택하는 별도 결과이며 모델 정확도 개선을 입증한 것이 아니다.
- 대량 임상 batch·3D 3개와 추론을 동시에 지속 실행하는 부하·모든 사용자 GPU/CPU 조합·다른 병원의 실제 DICOM은 추가 검증 대상이다.
- 설치본과 엔진 저장소가 분리되어 있다. 엔진은 이 PC에 구성했으며 installer만 다른 PC로 복사하면 추론 환경까지 생기지는 않는다. 재현 설치 명령과 정확한 dependency pins를 저장했다.
- 회원·서버 동기화·Web 결과 API·임상 승인·진단 성능 검증은 이번 작업 범위에 없다. Web에는 업로드/분석 기능이 없다.

## 코드 경계

`desktop/ui`는 표시와 사용자 선택, `preload.cjs`는 제한된 IPC, `imaging.cjs`는 입력 소유권/queue/취소/결과 게시를 담당한다. `imaging-worker.py`는 native 영상/preview/측정 검증/표면 생성, `model-runner.py`는 제공 모델 호출과 Windows 호환만 맡는다. `app/scene.tsx`의 선택·회전·애니메이션을 재사용하며 별도 3D 엔진을 복제하지 않았다.

Mask·weights·snapshot·진단 로그는 Desktop 내부 저장소에만 둔다. Web 자산이나 임의 파일 읽기 IPC를 만들지 않는다. 로컬 머신 소유자/관리자의 추출까지 차단하는 설계는 아니며, 그 위협까지 보호하려면 신뢰 서버 측 mask 처리와 허용 파생 결과 정책이 필요하다.

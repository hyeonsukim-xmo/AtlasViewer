# EXMO 개발 준비: 현재 구현 기준·변경 경계·단계별 검증

- 작성일: 2026-09-26, Asia/Seoul
- 앱 코드 기준: [`eca2152`](https://github.com/hyeonsukim-xmo/AtlasViewer/commit/eca2152079ae55236c278d3c567775f2bd598476), `design/marimo-glass`. 개발 준비에서 추가한 색상 회귀 검사는 별도이며 앱 동작을 바꾸지 않는다.
- 상태: 현재 Web·Windows Desktop 구현을 확인한 개발 준비 문서. 아래 후속 기능은 아직 구현하지 않았다.
- 우선순위: 기존 동작 보존 → 실제 입출력 확인 → 작게 연결 → 회귀 검증 → 범위 확장.
- 이번 작업: 기존 Desktop·렌더링 개선을 GitHub에 보존하고 문서와 색상 회귀 검사를 준비한다. 추가 앱 기능, 구조 개편, 의존성 교체는 수행하지 않는다.

이 문서가 후속 개발의 현재 기준이다. [제품 방향](EXMO_PRODUCT_ARCHITECTURE.md)은 제품 목표와 데이터 원칙, [영상 워크플로 검토](EXMO_IMAGING_WORKFLOW_REVIEW_2026-09-25.md)는 사용자가 설명한 상세 UX와 미결정 사항을 보존한다. 기존 문서의 과거 시점 구현 상태보다 이 문서의 기준 커밋을 우선한다.

**기존 기능의 회귀는 출시 차단 조건이다.** 테스트 통과가 모든 환경에서 부작용이 없다는 수학적 보장은 아니다. 변경 범위를 제한하고, 실제 영향 경로를 검증하고, 실패한 변경은 배포하지 않는 방식으로 요구를 지킨다. 원본 데이터와 완료 결과 보존도 같은 기준에 포함한다.

## 1. 현재 완료된 것과 앞으로 만들 것

| 영역 | 기준 커밋의 실제 상태 | 후속 범위 |
| --- | --- | --- |
| Web | React 19.2.6·Three.js 0.185.0·Vite 8.0.16, 정적 빌드 가능 | 실제 결과 선택, 영상 리뷰, 계정별 열람 |
| Desktop | Electron 44.4.5, Windows x64 실행 파일·NSIS 설치 파일 생성 가능 | 로컬 파일 가져오기, 분석 실행, 결과 저장 |
| 공통 UI | Web과 Desktop이 같은 `web/main.tsx` → `app/page.tsx`를 사용 | 별도 Desktop 전용 뷰어를 복제하지 않음 |
| Desktop 자산 | `atlas://app/`에서 번들 `dist/`를 제공, 모델·폰트·브랜드 로컬 포함 | 결과 파일 접근은 별도의 제한된 경로로 추가 |
| 3D | 고정 case 1001921, GLB 27 class / Lower Body 24개 | 결과별 모델과 대응 정보 입력 |
| 조작 | 복수 선택, 단일 그룹, hover, 분해·조립, 회전·복귀, 카메라 preset | 최대 3개 결과의 케이스 활성화·대응 구조 비교 |
| 측정값 | 가상 좌우 부피·지방침윤, Demo 표시 | 제공받은 실제 계산 결과 연결 |
| GPU | 시스템 기본 GPU 선호, 하드웨어 가속, 최대 pixel ratio 1.5, 움직일 때 display cadence에 맞춰 렌더링 | 큰 볼륨·3개 결과·추론 동시 사용 측정 후 조정 |
| 대기 상태 | 장면 정지·최소화 시 프레임 요청/장면 렌더링 중단 | 새 화면·상태 추가 후에도 유지 |
| 영상 입력·모델 | DICOM/NRRD/NIfTI reader, classification, segmentation 실행 미연결 | 기존 모델·계산 프로그램의 실제 입출력부터 연결 |
| 계정·저장 | 인증, 환자 DB, 결과 저장·동기화 미구현 | 사용 범위에 맞는 저장·권한 구현 |
| 배포 | 개발용 Windows 패키지 생성·실행 검증, 서명 없음 | 설치/업데이트 회귀 검증, 운영용 서명·배포 정책 |

현재 앱은 원본 NRRD나 DICOM을 열어 표시하는 프로그램이 아니다. 3D 자산과 가상 측정 UI를 표시한다. Electron 도입이 분석 모델의 GPU 실행 지원까지 완료했다는 뜻도 아니다.

## 2. 사용자 요구사항과 작업의 대응

아래 단계 ID는 9절에서 정의한다. 단계 순서는 개발을 작게 나눈 제안이며, 사용자의 화면 사용 순서와 동일할 필요는 없다.

| ID | 사용자 요구사항 | 현재/개발 단계 |
| --- | --- | --- |
| R01 | Web 데모와 Desktop 제공, 공통 UI, GPU를 적절히 쓰는 매끄러운 동작 | 현재 제공, 모든 단계에서 보존 |
| R02 | X-ray·MRI·CT, DICOM·NRRD·NIfTI·압축 NIfTI 입력 | P3, 모델별 지원 조건은 P1에서 확인 |
| R03 | 메타데이터 추출, Study 안의 Series 검토 | P3 |
| R04 | 기존 classification 모델로 사용 가능한 프로토콜 선택 | P5 |
| R05 | SeriesDescription hover 미리보기, 선택한 오른쪽 preview의 slice 스크롤 | P4 |
| R06 | case·StudyDescription·preview 바둑판, 방향 토글, 우클릭 해제 | P4 |
| R07 | 최종 입력을 segmentation에 전달, Value·Overlay·지방침윤 확인 | P5–P6 |
| R08 | 부피 cm³, 좌우·반대쪽·Diff, hovered side 우선 | Demo 동작 유지, 실제 값 P2·P6 |
| R09 | Follow-up/다른 환자 최대 3개 비교, 케이스 활성화·배경 해제 | P7 |
| R10 | Explode에서 대응 구조물 나란히 표시, 각각 독립 우클릭 회전 | P7 |
| R11 | 회원가입·로그인, 웹에서 허용된 결과 열람·비교 | P8 |
| R12 | EXMO 로고, Marimo glass, 기존 segment 색상·조작 유지 | 모든 단계의 필수 조건 |

최대 3개는 마지막 결과 비교 화면의 제한이다. 업로드 파일 수나 리뷰 카드 수를 3개로 제한하라는 요구가 아니다. 기존 classification·segmentation·지방 지표 계산을 먼저 연결하며, 새 모델 개발은 이 계획에 자동 포함하지 않는다.

## 3. 기존 동작 보존 기준

| ID | 보존할 동작 | 기준 파일/검증 |
| --- | --- | --- |
| B01 | 기본 진입 시 현재 case 1001921의 Lower Body 24개 표시, All은 27개 | `page.tsx`, `anatomy.ts`, 기존 GLB 검사 |
| B02 | 조립 상태의 개별 class 복수 선택·재클릭 해제, 그룹 필터는 단일 선택 | `selectStructure`, `changeGroup`, interaction 검사 |
| B03 | 선택한 Bone을 유지하면서 Posterior 그룹과 함께 보기 | `visibleStructures`, interaction 검사 |
| B04 | 배경 클릭/Esc 선택 해제, 숨김·격리·Reset 규칙 유지 | `page.tsx`, `anatomy.ts`, `pointer-tap.ts` |
| B05 | 버튼으로 Explode/Assemble 약 1,700ms, 분해 상태는 class 단일 선택·Front 기준 | `explosion-layout.ts`, `page.tsx` |
| B06 | 선택 구조 우클릭 회전, 해제·다른 선택·Assemble·Reset 시 약 700ms 복귀 | `segment-rotation.ts`, `scene.tsx` |
| B07 | 드래그를 클릭으로 처리하지 않음, pointer cancel/capture 해제, 키보드·동작 감소 설정 유지 | `pointer-tap.ts`, `scene.tsx` |
| B08 | Class 색상 27개·source ID·그룹 대응 보존, Muscle preset 유지 | `anatomy.ts`, `validate-atlas.mjs`의 고정 palette 대조 및 화면 비교 |
| B09 | 조명·재질·tone mapping·뷰어 배경 보존, UI 선택에 측면 강조 줄 재도입 금지 | `scene.tsx`, `globals.css`, 기준 화면 비교 |
| B10 | hover한 환자 side 우선, 반대쪽·Diff, 커서 사분면 배치·캔버스 경계 제한 | `model-side.ts`, `tooltip-position.ts`, `measurements.tsx` |
| B11 | Demo 수치는 Demo로 표시, 실제 값 누락을 Demo 또는 0으로 채우지 않음 | 현재 `demo-measurements.ts`, 후속 결과 경계 검사 |
| B12 | 필요할 때만 렌더링, idle/hidden/minimized 중단, 시간 기준 animation | `requestRender`/`tick`, Desktop 검사 |
| B13 | Web에서 Electron/Node API 없이 실행, Desktop은 서버 없이 번들 데모 열기 | Web smoke, Desktop 자산·sandbox 검사 |
| B14 | 모델 로드 실패 안내·재시도, unmount 시 요청·이벤트·GPU 자원 정리 | `scene.tsx`, `page.tsx`, 전환/실패 검사 |

선택 해제는 **현재 뷰의 기본 표시 상태로 복귀**하는 것이다. 현재 `scene.tsx`는 선택된 class가 있을 때 나머지 구조만 `contextOpacity`로 흐리게 한다. 선택이 없으면 이 dimming을 해제한다. 과거 대화의 “transparent”라는 표현만으로 현재 기본 재질·opacity를 새로 정의하지 않는다. 케이스 비교용 투명도는 별도 상태다.

고정 데모 GLB의 SHA-256은 `555dbad58e9642dd5aaf18040b1008cf0f6ac1809bd88d98a0ba925a30306b0c`다. 기존 검사에서 hash·7,660,116 bytes·212,316 vertices·424,456 triangles를 확인한다. 신규 데이터를 지원하기 위해 이 데모 검사를 느슨하게 바꾸지 않는다.

## 4. 코드 흐름과 변경 범위

### 4.1 현재 호출 흐름

```text
Web HTTP / Desktop atlas://app/
  → web/main.tsx → app/page.tsx
      → anatomy.ts의 선택·필터 규칙 → SceneState
      → scene.tsx: 고정 GLB → Mesh/Pivot → OrbitControls → 필요 시 렌더링
      → measurements.tsx: 전역 DEMO_MEASUREMENTS
      → scene.tsx의 hover: 같은 MeasurementTable 재사용
      → agent-tools.ts: 동일한 choose 경로로 구조 선택
```

| 파일 | 현재 책임 | 해당 기능 착수 시의 최소 변경 |
| --- | --- | --- |
| [web/main.tsx](../web/main.tsx) | 앱 진입과 공통 CSS | 두 번째 실제 화면이 생길 때만 화면 전환 연결 |
| [app/page.tsx](../app/page.tsx) | 선택·필터·패널·로드 상태, case 문구, 단축키 | 결과 입력·진입 화면 연결. 분석 실행 코드를 넣지 않음 |
| [app/anatomy.ts](../app/anatomy.ts) | 27 class, 색상, 순수 선택 함수 | 기존 규칙 보존. 새 catalog가 필요할 때만 명시적으로 확장 |
| [app/scene.tsx](../app/scene.tsx) | 로드·좌표 변환·material·raycast·애니메이션·정리 | 결과 자산 입력, 수명주기, 이후 인스턴스 식별만 단계별 변경 |
| [app/measurements.tsx](../app/measurements.tsx) | 목록/hover 공통 표 | 동일 결과의 측정값을 명시적 입력으로 받기 |
| [app/demo-measurements.ts](../app/demo-measurements.ts) | 가상 값과 표시용 좌우 차이 함수 | 가상 fixture로 유지. 실제 데이터의 fallback으로 사용 금지 |
| [app/model-side.ts](../app/model-side.ts) | 현재 자산의 +X 환자 Left 규칙 | 현재 데모에만 사용, 새 결과는 명시적 대응 정보 사용 |
| [app/explosion-layout.ts](../app/explosion-layout.ts), [app/camera-fit.ts](../app/camera-fit.ts) | 배치·카메라 계산 | 기존 순수 함수 재사용, 비교 범위가 생길 때 필요한 입력만 추가 |
| [app/segment-rotation.ts](../app/segment-rotation.ts), [app/pointer-tap.ts](../app/pointer-tap.ts) | 개별 회전·복귀와 tap 판별 | 그대로 재사용, 인스턴스별로 소유 |
| [app/agent-tools.ts](../app/agent-tools.ts) | 선택/검색의 선택적 WebMCP 노출 | catalog가 바뀌는 단계에서 화면과 동일 대상으로 연결 |
| [app/globals.css](../app/globals.css), `components/ui/` | 스타일·공통 입력 요소 | 현재 스타일 재사용, 새 화면 범위의 클래스만 추가 |
| [desktop/main.cjs](../desktop/main.cjs) | 창, sandbox, 번들 protocol, navigation 제한 | native 작업이 생기는 단계에서 제한된 IPC 연결 |
| [vite.config.ts](../vite.config.ts), [package.json](../package.json) | Web 빌드와 Desktop 패키징 | 실제 추가 파일/실행물이 생길 때만 변경 |

### 4.2 실제 확장 시 반드시 해결할 결합

1. `scene.tsx`는 URL뿐 아니라 **파일 크기 7,660,116 bytes와 27개 mesh 일치**까지 고정한다. URL만 바꾸면 새 결과를 정상적으로 열 수 없다. 크기·catalog·mesh 매핑의 검증을 새 입력 계약으로 이동하고, 데모 계약은 유지한다.
2. `MeasurementTable`이 전역 Demo 값을 직접 읽는다. 목록만 실제 값으로 바꾸면 hover에 Demo가 남는다. 두 호출 지점과 `page.tsx`/About/aria-label의 Demo 문구까지 같은 결과 출처를 사용해야 한다.
3. `scene.tsx`의 초기화 effect는 `[]`이고 현재 재시도는 `key={attempt}`로 재마운트한다. 새 result prop만 추가해도 effect가 새 모델을 자동 로드하지 않는다.
4. 현재 `sideFromTriangle`의 X 부호는 검증된 데모에 한정된다. 새 GLB에 같은 규칙을 무조건 적용하지 않는다.
5. 현재 `scale = 2.4 / 모델 높이`는 단일 모델 프레이밍에 쓰인다. 세 케이스 각각에 적용하면 실제 크기 차이가 사라진다. 비교 모드에는 공통 물리 축척을 사용하고 단일 데모의 기존 프레이밍은 보존한다.
6. 현재 `Map<StructureId, Piece>`와 우클릭 처리는 class 하나만 식별한다. 비교에서는 result와 실제 구조 인스턴스까지 알아야 한다. 이 변경은 P7에서 수행한다.
7. `STRUCTURES`는 페이지, 선택 함수, 모델 로더, 측정 UI, WebMCP가 함께 사용한다. `StructureId`를 임의 문자열로 넓히거나 일부 호출만 새 catalog로 바꾸지 않는다.
8. CSS가 `@source "./"` 및 기존 UI 파일을 명시적으로 스캔한다. 새 UI를 다른 디렉터리에 두면 빌드에서 스타일이 생성되는지 확인한다. 폴더 정리만을 위한 대규모 이동은 하지 않는다.
9. 현재 Desktop 패키징은 번들 `dist/`·`desktop/` 등을 포함하고 `node_modules`를 제외한다. main/preload가 새 runtime 의존성을 직접 import하거나 별도 분석 실행물을 추가하는 단계에서는 패키지 포함 규칙도 함께 검증해야 한다. 개발 실행이 된다는 이유로 설치 파일에서도 동작한다고 가정하지 않는다.

### 4.3 Ponytail을 적용하는 방식

- 기능 하나의 실제 호출 경로를 먼저 읽고, 이미 있는 순수 함수와 UI 요소부터 재사용한다.
- 파일 길이만 줄이려고 `scene.tsx`를 여러 manager/service로 쪼개지 않는다. 실제 두 번째 소비자 또는 분명한 독립 책임이 생긴 부분만 추출한다.
- 처음부터 DI container, 범용 repository/provider, event bus, 플러그인 시스템, 새 전역 상태 라이브러리를 추가하지 않는다.
- 화면 상태는 가까운 React state, 복잡한 상태 전이는 작은 순수 함수로 시작한다. 초기 한 분석 작업을 위해 분산 작업 큐를 만들지 않는다.
- 영상 디코더·MPR·인증을 직접 재구현해서 코드가 더 커지면 기존 검증된 도구를 검토한다. 의존성 도입 시 지원 입력·실패 처리·배포 크기를 작은 실제 샘플로 먼저 확인한다. 아직 reader/MPR/auth 제품을 확정하지 않는다.
- 외부 입력 검증, 저장 실패 처리, 접근 제어, 취소/정리, 접근성은 간소화 대상이 아니다.
- 알려진 한계를 수용할 경우 해당 코드에 `ponytail:` 주석으로 한계와 교체 조건을 짧게 남긴다. 예: 동시 분석 1개 제한은 실제 병렬 실행 요구가 확인될 때 재검토.
- 리팩터링과 기능 추가, 패키지 전체 업데이트, 디자인 변경을 같은 변경에 섞지 않는다.

## 5. 데이터 계약: 실제 제공물을 보고 확정할 최소 범위

아래는 **제안 계약**이며 아직 TypeScript 타입·DB schema·API를 생성하지 않는다. P1에서 실제 제공 출력과 대조해 필드를 확정한다. 필드가 필요해지는 단계에 맞춰 구현하고, 전달받지 않은 정보를 추정해서 채우지 않는다.

### 5.1 검사 입력

| 대상 | 필요한 의미 | 검증/규칙 |
| --- | --- | --- |
| 환자·Study·Series | 앱 내부 ID, 원본 UID가 있으면 별도 보존, 표시명·촬영일·설명 | SeriesDescription은 표시용. 문자열 일치만으로 병합 금지 |
| 파일 묶음 | 선택한 파일의 안정적인 참조, 형식, 크기, 원본/파생 구분 | 파일명이 아니라 내용과 series 관계 확인, 중복·누락 표시 |
| 볼륨 | dimensions, datatype, spacing, 원점, 방향, voxel→patient 변환과 단위 | 배열 크기와 메모리 상한, 유한 값·지원 차원 검증 |
| 영상 종류 | modality, protocol, 영상/labelmap 구분 | 확장자만으로 CT/MRI나 intensity/mask를 단정하지 않음 |
| provenance | 원본 참조와 변환·재배열·resampling 이력 | 분석 입력이 원본과 어떻게 연결되는지 추적 |

NRRD/NIfTI에 StudyDescription 등이 없으면 누락으로 표시하고, 제공된 메타데이터 JSON과 확인된 키로 연결한다. 공간 정보가 존재한다고 검사 설명까지 복원할 수 있다고 가정하지 않는다. 구체 형식·DICOM 정렬·MPR 조건은 [영상 검토 4–6절](EXMO_IMAGING_WORKFLOW_REVIEW_2026-09-25.md)에 따른다.

### 5.2 완료 결과

| 묶음 | 제안 필드/의미 | 필수 조건 |
| --- | --- | --- |
| 결과 식별 | schema version, immutable result/revision ID, analysis run ID | 같은 입력 재분석도 새 result ID. 파일 일부만 완료로 노출 금지 |
| 검사 참조 | patient/Study/Series ID, 촬영일, 표시 이름 | 결과 하나가 여러 입력 series를 참조할 수 있음 |
| 분석 출처 | 모델·계산 방법 버전, 실제 입력 목록, 실행 설정 | 서로 다른 실행의 mask·값·mesh를 섞지 않음 |
| 자산 | GLB, mask, 원본/preview 참조, 크기와 무결성 정보 | 실제 파일 존재·지원 형식·참조 범위 확인 |
| 공간 | 좌표계·mm 단위, 각 볼륨의 voxel→patient, mesh→patient 변환 | 축/행렬 순서/적용 순서를 P1 샘플과 함께 고정 |
| 구조 대응 | 결과 안의 instance ID, class ID, side, label/layer, mesh node 또는 primitive 대응 | 표시 이름이 아닌 안정적인 ID 사용. 중복·알 수 없는 참조 거부 |
| 측정 | class·side·metric·값·단위·method·상태·산출 범위 | null과 실제 0 구분, 비유한/음수 부피 등 잘못된 값 거부 |
| 출처 표시 | 측정값이 Demo인지 실제 분석 출력인지 | 현재 데모는 형태 자산과 가상 측정의 출처가 다름. 출처 표시도 이를 표현 |

측정이 없는 실제 결과도 모델을 열 수 있지만 해당 값은 `—`와 이유를 보여야 한다. “없으면 `DEMO_MEASUREMENTS`를 반환”하는 fallback은 금지한다. 실측 데이터에는 모델/계산 검증 상태를 넘어선 정확도 표현을 붙이지 않는다.

첫 reader는 지원하는 schema version만 읽고, 알 수 없는 버전은 명확히 거부한다. 아직 쓰지 않는 마이그레이션 엔진은 만들지 않는다. 첫 실제 schema를 저장한 뒤에는 변경 시 기존 자료를 읽는 방법 또는 변환 절차를 같은 작업에 포함한다.

### 5.3 좌표·좌우·비교 크기

- 환자 Left/Right와 화면 Left/Right를 구분한다. 새 결과의 side는 원본 label/방향/대응 정보로 확인한다.
- 양쪽을 포함한 class mesh와 한쪽 구조 인스턴스를 구분한다. 불명확·정중 구조·좌우 비대상 상태를 표현하고 임의 side를 붙이지 않는다.
- voxel 배열 순서, voxel 중심 정의, 행렬 저장 순서, GLB node transform 적용 전후를 계약 예시에서 명시한다. “affine 있음”만으로 서로 다른 행렬을 혼용하지 않는다.
- 변환은 `voxel 또는 mesh → 환자 mm → 표시 공간`으로 추적한다. 중심화·Explode·회전은 표시 상태이며 측정 원본을 수정하지 않는다.
- 서로 다른 환자/검사의 patient 좌표 숫자가 같다고 정합된 것은 아니다. 나란히 보기는 방향과 공통 mm 축척을 유지하고 배치용 평행 이동을 추가하는 수준부터 시작한다.
- 기존 단일 데모 프레이밍과 비교 화면의 물리 축척을 구별한다. 신규 결과의 물리 변환을 모르면 크기 비교 기능을 정상 완료로 표시하지 않는다.
- 부피·지방 지표의 실제 계산은 제공 프로그램을 사용한다. 렌더링용으로 변형한 mesh에서 대신 계산하지 않는다.

### 5.4 값의 차이

기존 좌우 UI는 부피 `abs(L-R) / mean(L,R) × 100`, 지방 비율 차이 `abs(L-R)` pp를 사용한다. 부피 양쪽이 0이면 상대 차이는 미정의다. 이 규칙은 보존하며 임상 기준으로 해석하지 않는다.

Follow-up의 부호 있는 변화량/변화율은 좌우 절대 차이와 별도다. 기준 0, 한쪽 결측, 다른 계산 방법, 촬영 범위 차이의 처리를 실제 데이터로 확정한 뒤 구현한다. 같은 이름의 CT/MRI 지방 지표를 곧바로 같은 척도로 합치지 않는다.

## 6. 화면 상태와 부작용 방지

### 6.1 영상 선택·미리보기

| 상태 | 의미 | 다른 상태에 미치는 영향 |
| --- | --- | --- |
| hover 대상 | 일시적으로 가리킨 Series | 분석 대상에 자동 추가하지 않음 |
| 고정 preview | 클릭해서 오른쪽에 유지한 Series | 마우스가 preview로 이동해도 유지 |
| 분석 대상 목록 | 리뷰 카드에서 포함하기로 선택한 입력 | 우클릭 해제는 이 목록에서 제외, 원본 삭제 아님 |
| 카드별 view 상태 | 방향·물리 위치/slice·window 설정 | 다른 카드나 3D 선택을 변경하지 않음 |
| 실행 입력 snapshot | 분석 시작 시 확정한 입력과 설정 | 실행 중 목록 편집으로 바뀌지 않음 |

고정 preview가 있을 때 다른 Series hover를 어디에 보여줄지는 미결정이다. 구현 전 작은 화면 예시로 결정하고, hover 종료 후 돌아갈 고정 대상을 유지한다. 분석 시작은 별도 명시적 버튼을 제안한다. 우클릭 해제만으로 모델을 자동 실행하지 않는다.

Preview 요청에는 현재 대상 ID/요청 순서를 연결한다. A→B로 이동했을 때 늦은 A 응답이 B를 덮어쓰지 못하도록 이전 요청 취소와 최신 요청 확인을 함께 적용한다. 변환 작업이 취소 불가하면 오래된 결과를 폐기한다. 화면 해제 시 worker·buffer·object URL·이벤트의 소유자가 정리한다.

휠 입력은 preview 안에서 slice를 이동하고 그 이벤트만 소비한다. 3D 확대와 페이지 스크롤을 전역에서 가로채지 않는다. Axial/Sagittal/Coronal은 방향·spacing을 반영한 볼륨 단면이다. 볼륨이 없는 입력에는 불가능한 view를 만들어 보여주지 않는다.

### 6.2 결과 전환

최소 구현은 **결과 ID와 재시도 번호를 포함한 React key로 결과 뷰어 전체를 재마운트**하는 방식이다. 현재 `key={attempt}` 흐름을 확장하되, scene만 교체하고 이전 결과의 선택·측정·오류를 부모에 남겨두지 않도록 뷰어 상태 소유 범위를 함께 정한다. 같은 결과 안의 선택/hover마다 재마운트해서는 안 된다. React의 key가 상태 경계를 다시 만드는 동작은 [공식 설명](https://react.dev/learn/preserving-and-resetting-state)을 따른다.

결과 변경 시 이전 fetch와 callbacks를 무효화하고, hover·선택·드래그·진행률·오류를 해당 결과 기준으로 초기화한다. 이전 GPU 자원이 해제되기 전에 새로운 scene을 무제한 쌓지 않는다. 동시에 두 결과를 살아 있게 유지해야 하는 비교 화면은 P7에서 명시적으로 소유한다.

기존 scene의 abort/dispose 경로를 재사용하고, 로드 도중 실패·빠른 전환·앱 종료에서도 해제되는지 검증한다. 정리 함수가 있다는 사실만으로 모든 비동기 실패 경로의 해제가 검증됐다고 간주하지 않는다.

### 6.3 최대 3개 비교

사용자 확정 요구는 최대 3개, 케이스 클릭 활성화, 조작 없는 배경 클릭 시 전체 보기, 대응 구조 나란히 보기, 각 구조 독립 회전이다. 아래의 세부 해제 우선순위는 **권장안**이며 P7 착수 전에 확정한다.

| 현재 상태/입력 | 권장 전이 | 보존해야 할 것 |
| --- | --- | --- |
| 전체 보기 → A 클릭 | A 활성화, B/C 흐리게 표시 | B/C 결과·기본 배치 |
| A 활성·구조 미선택 → 배경 | 활성 해제, 전체 보기 | 선택한 최대 3개 결과 목록 |
| A 조립 상태 → 구조 클릭 | A의 기존 class 복수 선택 규칙 | 그룹 단일 선택 |
| A 구조 선택 중 → 배경/Esc | 구조 선택부터 해제, A 활성 유지 | 기존 단일 뷰의 해제 규칙 |
| A 활성 → Explode | A 구조 펼침 | 분해 1.7초와 레이아웃 규칙 |
| A 펼침 → Femur 클릭 | A/B/C의 대응 Femur 비교 | class/side·케이스 식별, 공통 축척 |
| 구조 위 우클릭 드래그 | 시작 위치의 해당 인스턴스만 회전 | 각자의 pivot, 이웃 quaternion |
| 구조 비교 해제/다른 구조 선택 | 각 회전을 0.7초 복귀 | 원본 geometry·원본 방향 정보 |
| 비활성 케이스 클릭 | 케이스 활성화부터 처리하는 안 | 한 클릭으로 의도하지 않은 구조 선택 방지 |
| 비교 대상 제거 | 그 결과의 드래그/로드/자원 해제 | 남은 결과·원본 파일 보존 |

케이스 활성 ID, class 선택, 실제 드래그 instance는 별도 의미다. `resultId + instanceId`로 객체를 구분하고 대응 비교는 class/side로 연결한다. 현재 단일 뷰의 `SceneState`에 모든 workflow 상태를 몰아넣지 않는다.

케이스 opacity와 주변 구조 opacity를 무조건 곱하지 않는다. P7에서 표시 우선순위와 hit 대상을 명시하고, 흐린 케이스가 활성 구조 클릭을 가로채지 않는지 검증한다. 케이스를 구분하기 위해 class 색상을 바꾸지 않는다.

현재 Femur는 양쪽을 한 class로 선택한다. **세 케이스의 양쪽 Femur 묶음을 비교할지, 한쪽 Femur를 각각 비교할지는 미결정**이다. 이 결정을 먼저 해야 instance 매핑·pivot·측정 대상이 일치한다. 대응 구조가 없는 케이스는 누락 사유를 표시한다.

## 7. Desktop·Web·분석 실행의 책임

```text
공통 React UI / Three.js 결과 뷰어
  ├─ Web: 브라우저 파일 선택/허용된 API → 검증된 데이터
  └─ Desktop: 제한된 preload 기능 → main의 파일/작업 관리 → 분석 실행물

분류/분할/측정 결과 → 검증된 불변 result → 같은 목록·hover·Overlay·3D
```

이 도식은 책임 경계다. 파일마다 interface·adapter·factory를 하나씩 만드는 폴더 설계가 아니다.

### 7.1 Desktop 경계

현재 preload와 native 작업 IPC는 없다. 파일 접근이 필요한 P3에서만 추가한다. `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, navigation/window 제한을 유지한다. renderer에 `fs`, `shell`, 임의 `ipcRenderer.send/invoke`를 그대로 노출하지 않는다. 작업별 좁은 함수, IPC sender/frame·인자 검증을 사용한다. [Electron 보안 지침](https://www.electronjs.org/docs/latest/tutorial/security), [contextBridge](https://www.electronjs.org/docs/latest/api/context-bridge)

Main이 소유한 파일 선택 결과·asset ID를 통해 접근한다. 임의 절대 경로를 UI가 보내면 읽어주는 API, 번들 protocol을 디스크 전체 정적 서버로 바꾸는 방식은 금지한다. 결과 파일은 별도의 제한된 handler에서 허용된 root·실제 경로·파일 참조를 검증한다. 경로 이탈과 링크를 통한 우회를 포함해 검사한다.

현재 CSP는 `connect-src 'self'`다. 신규 Blob/데이터 protocol/API가 필요하면 해당 용도만 허용하고 실패·외부 접근 차단을 함께 검증한다. CSP를 `*`로 풀거나 sandbox를 끄는 방식으로 로딩 문제를 해결하지 않는다.

영상 디코드·압축 해제·추론을 renderer 또는 main 이벤트 루프의 긴 동기 작업으로 실행하지 않는다. 실제 제공 프로그램에 맞는 작업 프로세스/worker 하나부터 연결한다. Web 번들이 Electron import에 의존하지 않도록 경계 파일을 분리한다.

### 7.2 분석 작업

제안 상태: `queued → running → validating-output → completed`, 별도 `failed / cancelled / interrupted`. 필요한 실제 단계만 상태로 둔다. classification과 segmentation이 같은 API/바이너리라고 가정하지 않는다.

- 실행할 때 입력 snapshot, 모델·계산 버전, 설정, 출력 임시 디렉터리를 작업 ID에 고정한다.
- 허용된 실행 파일을 shell 문자열 조립 없이 인자 배열로 실행한다. 사용자 파일명을 명령어로 해석하지 않는다.
- 첫 구현은 동시에 한 분석 작업을 처리한다. GPU 종류·메모리·모델 요구를 확인하고 OOM은 재시도 가능한 실패로 보존한다. CPU fallback은 실제 모델이 지원할 때만 제공한다.
- 취소는 소유한 작업과 자식 프로세스 범위만 종료한다. Windows에서 다른 Python/Electron 프로세스를 일괄 종료하지 않는다.
- 완료는 exit code만으로 판정하지 않는다. 필요한 mask·측정·mesh·변환의 존재와 대응을 검증한 뒤 결과를 공개한다.
- 임시 결과와 완료 결과를 구분하고 저장 실패·앱 종료 시 미완료를 정상 결과로 읽지 않는다. 재시작 시 중단 작업을 표시하고 재실행한다. 중간 계산 위치부터 재개하는 기능은 첫 범위에 넣지 않는다.
- 화면 진행률은 프로그램이 제공하는 정보에 근거한다. 정보가 없으면 단계/진행 중 상태를 사용한다.

모델 가중치·분석 runtime의 크기와 배포 권한, 설치/업데이트 위치는 실제 제공물로 정한다. 패키지 안팎의 실행 경로를 명시하고 설치된 앱에서도 실행·취소를 확인한다. 기존 `public/`에 환자 입력이나 모델 가중치를 넣어 Web 번들/Git에 노출하는 방식으로 연결하지 않는다.

### 7.3 Web·로컬 저장

Web에서 파일을 선택하는 것과 서버로 업로드하는 것은 별도 동작이다. 분석 위치·전송 범위를 정하지 않은 상태에서 원본을 자동 업로드하지 않는다. 정적 사이트만으로 기존 Python/GPU 모델이 실행된다고 표시하지 않는다.

처음에는 불변 결과 묶음을 안전하게 저장·재열람하는 기능부터 구현한다. 로컬 DB/서버 DB 종류는 실제 이력 조회·쓰기 요구를 확인한 단계에서 정한다. Web에서는 회원가입뿐 아니라 API와 자산 다운로드 모두에 결과별 접근 권한이 필요하다.

동기화는 안정적인 result ID로 중복을 방지하고, 필요한 파일이 모두 확인된 뒤 서버 완료로 표시한다. 업로드 실패가 로컬 완료 결과를 지우지 않도록 한다. 앱 코드 rollback과 환자 데이터 복구는 별개다.

## 8. GPU·메모리·렌더링 기준

현재 렌더링 방식은 유지한다. frame마다 React state를 갱신하거나, 새 패널 때문에 scene을 재생성하거나, 항상 도는 별도 RAF를 추가하지 않는다. WebGL 자산과 큰 voxel 배열을 React state에 중복 복사하지 않는다. 화면 표시용 상태와 무거운 자원의 소유권을 구분한다.

Preview 카드는 대표 이미지를 우선 사용하고, 활성 preview에 필요한 데이터만 추가 로드한다. worker는 UI 스레드 정지를 줄이는 수단이지 메모리를 무제한 늘리는 수단이 아니다. 입력 크기·압축 해제 결과·동시 볼륨 수에 한도를 두고 실제 장비에서 정한다.

P7에서는 기존 Three.js renderer 안에 케이스별 group/pivot를 두는 방식부터 검토한다. 전체 뷰어 세 개를 그대로 띄워 WebGL context·GLB·RAF를 중복시키는 접근은 성능 측정 없이 기본안으로 채택하지 않는다. 프레임 루프를 공유하는 변경도 P7의 독립 검증 대상으로 둔다.

| 관측 항목 | 현재 근거 | 후속 통과 기준 |
| --- | --- | --- |
| idle | 600ms 구간 RAF 0 / render 0 | settling 후 같은 조건 유지 |
| minimized | 600ms 구간 RAF 0 / render 0 | hidden 중 UI 작업이 새 3D 루프를 만들지 않음 |
| 회전 pacing | RTX 3050 환경, 1초 구간 RAF/render 101/101, 간격 median 10ms·p95 10.1ms | 실제 display callback을 임의 60fps gate로 건너뛰지 않음 |
| 복귀 | 실측 렌더링 후 idle 복귀, 700ms 로직 검사 | 종료 후 잔여 polling/회전 없음 |
| 3개 결과·추론 동시 사용 | 아직 측정하지 않음 | 대상 모델/장비에서 프레임 간격·GPU/CPU 메모리·입력 지연 측정 후 기준 확정 |

위 수치는 이 PC의 짧은 smoke 구간에서 얻은 렌더 호출 관측이다. 모든 장비의 100fps, 화면 present 시간, GPU 사용률을 보장하지 않는다. scene 렌더 0은 앱 전체 GPU 사용률 0이라는 뜻도 아니다. 성능 회귀 비교는 같은 데이터·창 크기·해상도·전원/드라이버 조건에서 진행하고, 차이가 보일 때 반복 측정해 원인을 분리한다.

해상도·재질·mesh를 자동으로 낮춰 성능 수치만 맞추는 변경은 하지 않는다. 필요하면 사용자가 확인할 품질 선택과 근거를 별도 제안한다.

## 9. 단계별 개발 계획

각 단계는 독립적으로 검토·되돌릴 수 있는 변경으로 진행한다. 아래의 “완료 조건”을 통과하기 전에 기본 진입 동작을 새 흐름으로 교체하지 않는다. 모든 새 기능은 사용자가 명시적으로 선택한 진입점에서 시작하고 기존 데모로 돌아갈 수 있어야 한다. 범용 feature flag 서비스는 필요 없다.

### P0. 기준 보존 및 부족한 검증 보강

- 현재 완료: 기준 커밋 GitHub 보존, 타입·기존 검사·실제 Desktop smoke 통과, 기존 요구와 계획 문서화. 개발 준비에서 `validate-atlas.mjs`에 승인된 27개 class 색상 대조를 추가했다.
- 개발 착수 시: 기존 단일 뷰를 Web/패키지 양쪽에서 확인하고, 영향을 받는 시각 동작의 기준을 보강한다.
- 최소 변경: 기존 검사 파일과 필요한 UI 시나리오. 앱 로직/스타일 변경 없음.
- 완료 조건: 실제 색상을 한 개 바꾸면 검사가 실패하고, 기존 선택·분해·복귀 경로가 기준과 일치한다. 이번 색상 검사 확인은 실행 중인 앱 파일을 수정하지 않고 별도 Node 프로세스의 메모리에서 값을 바꿔 수행한다.
- CI는 현재 저장소에 없다. 실제 자동화 도입 시 타입·순수 검사·Web 빌드를 우선하고, GUI/GPU Desktop 검사는 별도 가능한 Windows 환경에서 수행한다. GUI 검사를 실행하지 않고 통과로 표시하지 않는다.

### P1. 기존 모델·계산 출력 계약 확인

- 입력: 대표 원본·mask·측정 결과·GLB, label/side 매핑, classification/segmentation 실행 방법, 제공 예정 리뷰 HTML.
- 산출: 한 결과의 ID·좌표·단위·출처 대응표와 지원 입력 목록. 필요한 작은 합성 fixture와 validator.
- 변경 범위: 검증 데이터/문서/검사. 기존 뷰어를 먼저 범용화하지 않는다.
- 완료 조건: 원본의 알려진 위치·좌우·측정값이 결과와 일치하고, 잘못된 단위/누락/중복 ID를 거부한다.
- 자료 미제공 시: Demo라고 표시한 합성 입력의 계약 실험까지만 가능. 실제 분석 연결 완료로 처리하지 않는다.

### P2. 단일 실제 결과 뷰어 연결

- 입력: P1의 검증된 결과. 첫 결과는 현재 catalog와의 대응을 명확히 하고, 구조 누락/추가 지원 범위를 명시한다.
- 최소 변경: `page.tsx`, `scene.tsx`, `measurements.tsx`의 결과 입력, 필요할 때 작은 결과 validator와 Demo 결과 구성 파일.
- 데모의 고정 값은 기본 결과 정의로 모으고, 실제 값 누락을 Demo로 대체하지 않는다. 로더의 고정 크기·catalog 가정은 입력 검증으로 옮긴다.
- 결과 교체는 수명주기를 명확히 하는 key 재마운트부터 사용한다. catalog/측정/hover/WebMCP가 같은 활성 결과를 참조하도록 호출자를 함께 확인한다.
- 완료 조건: Demo → A → B → Demo 전환, A 로딩 중 B 전환, 손상 결과·재시도에서 데이터/선택/오류가 섞이지 않는다. 기존 단일 뷰 B01–B14 통과.
- rollback: 결과 입력 연결 변경을 되돌리면 기존 데모가 그대로 실행된다. 기존 GLB·가상 자료는 삭제하지 않는다.

### P3. 가져오기와 메타데이터 목록

- 입력: P1에서 첫 번째로 지원하기로 한 실제 형식과 대표 실패 사례.
- 최소 변경: 새 가져오기 화면/reader 연결, Desktop에서 필요한 preload·IPC와 테스트. 기존 3D 화면은 명시적으로 진입할 때만 사용.
- 한 입력 형식의 정상/실패 경로를 먼저 완료하고 DICOM·NRRD·NIfTI·압축 NIfTI를 같은 의미의 입력으로 순차 연결한다.
- 동일 설명의 다른 Series, 누락 설명, 다중 프레임/차원, 손상/과대 파일·취소를 처리한다. 지원하지 않는 변형은 이유와 함께 거부한다.
- 완료 조건: 환자/Study/Series가 잘못 합쳐지지 않고 원본을 변경하지 않는다. Web 빌드에 native API가 유입되지 않으며 Desktop의 protocol/sandbox 검사가 유지된다.

### P4. Series preview와 바둑판 리뷰

- 입력: P3의 볼륨/메타데이터와 리뷰 HTML의 실제 동작.
- 최소 변경: 영상 preview·리뷰 화면, 카드별 view 상태, 디코드/MPR 연결. Three.js 결과 렌더링 루프는 변경하지 않는다.
- hover와 클릭 고정, 해당 preview의 wheel slice, 방향 토글, 우클릭 선택 해제와 키보드/버튼 대안을 구현한다.
- 완료 조건: 빠른 A→B hover에서 역전 없음, preview 이동 시 고정 유지, 방향/LR·물리 비율 일치, 리뷰 카드 취소가 원본 삭제나 3D 회전으로 이어지지 않음.
- 실제 라이브러리는 P1 샘플의 디코드·MPR·메모리 검증을 통과한 하나를 선택한다. 범용 viewer를 직접 새로 작성하지 않는다.

### P5. 분류와 segmentation 작업 연결

- 입력: 실행 가능한 기존 모델, 지원 protocol 정의, 자원 요구와 결과 계약.
- 최소 변경: 분석 실행·취소·상태 처리와 입력 snapshot, 실제 실행 경로 하나. 새 모델 훈련/추론 플랫폼 제작은 제외.
- classification 결과와 입력 유효성 검증을 구분한다. 분류 불확실/미지원·실행 실패를 정상 지원으로 바꾸지 않는다.
- 완료 조건: 사용할 입력만 분석에 전달되고, 취소/OOM/프로세스 종료/출력 손상에서 UI·원본·이전 결과가 유지된다. 재실행은 새 결과를 만든다.
- 예외: 웹 데모의 서버/로컬 실행 위치는 이 단계 전 결정한다. 모델 실행을 모사했다면 Demo임을 명시한다.

### P6. Value·Overlay·실측·저장·재열람

- 입력: 검증된 mask·원본 공간·측정 출력·mesh.
- 최소 변경: P2 결과 입력에 실제 작업 출력 연결, P4 영상 화면에 label Overlay, 결과 저장/열기.
- Value 행과 해당 class/side Overlay를 연결한다. 구조가 없는 slice일 때 이동/안내 기준은 실제 영상으로 정한다.
- 완료 조건: 목록·hover·Overlay·3D가 같은 immutable result를 참조하고, 좌우·단위·결측값 처리 일치. 앱 재시작 후 같은 결과 열기, 저장 실패/중단 시 이전 완료 결과 유지.
- 지방 값만 있는 출력에는 존재하지 않는 지방 분포 Overlay를 생성하지 않는다.

### P7. 최대 3개 비교와 Follow-up

- 입력: 동일 환자 두 시점과 다른 환자 결과, class/side·물리 공간 대응. 양쪽/한쪽 비교 단위와 클릭 전이 결정.
- 최소 변경: 비교 화면의 결과 목록·활성 케이스, renderer의 케이스 group/instance identity/picking, 공통 축척. 기존 회전/배치 함수를 재사용한다.
- 단일 뷰 refactor가 필요하면 먼저 동작 동일한 변경을 검증하고 다음 변경에서 비교 기능을 추가한다. 새 비교 renderer 전체를 복제하지 않는다.
- 완료 조건: 1/2/3개와 4번째 선택 거부, 케이스/구조 해제, 대응 구조 누락, 각자의 pivot 회전과 700ms 복귀, 같은 mm 축척, 데이터 혼합 없음. B01–B14와 메모리/성능 검사 통과.
- Follow-up 변화와 다른 환자의 차이를 구분한다. slice 동기화·겹쳐 보기·변형 지도는 별도 정합 작업으로 분리한다.

### P8. 회원·권한·선택 동기화·웹 열람

- 입력: 사용자/소속/공유 정책, 원본·mask·GLB·측정 중 전송 범위, 저장 보존 정책.
- 최소 변경: 필요한 계정·결과 API와 비공개 저장, 공통 결과 로더 연결. 기존 로컬 데모에 불필요한 로그인 의존성을 만들지 않는다.
- 완료 조건: 허용된 계정이 같은 result를 열고, 다른 계정/소속의 API·파일 직접 접근은 거부된다. 중단·재시도에도 중복/잘못된 완료 없음. 동기화 실패가 로컬 완료 결과에 영향 없음.
- 서버 제품·인증 라이브러리·DB는 구현 시 실제 요건으로 선택한다. 범용 권한 편집기/마이크로서비스/다중 클라우드를 선행 구축하지 않는다.

## 10. 회귀 검증과 완료 기준

### 10.1 지금 있는 검사와 한계

| 명령/검사 | 확인하는 것 | 확인하지 못하는 것 |
| --- | --- | --- |
| `npm run check` | TypeScript 검사 | 실제 렌더링·외부 파일 내용 |
| `npm test` | 고정 GLB hash/geometry, 승인된 class 색상 27개, class/side, 순수 선택 규칙, palette 함수, tooltip 배치, 45개 그룹·비율 배치, 카메라, 회전/복귀, tap·WebMCP 입력 | 실제 영상 reader/모델·전체 UI 이벤트·재질/조명 포함 시각 변화 |
| `npm run test:desktop` | production build, 실제 Electron, 번들 자산·sandbox/protocol, idle/회전/최소화, 선택·분해·복귀·재조립 | 외부 Chrome의 전체 UI, 설치/업데이트, 실제 모델 추론, 세 결과 성능 |
| packaged ASAR 검사 | 패키지 내부 앱/자산을 통한 같은 smoke | NSIS 설치 마법사·사용자 데이터 마이그레이션 |
| 화면 확인 | 로고·배경·재질·색상·glass·선택·hover·레이아웃 | 픽셀 스냅샷만으로 의미상 측정 정확도를 보증할 수 없음 |

기준 커밋의 palette 검사는 함수가 현재 `STRUCTURES` 색상을 반환하는지만 확인했다. 이번 준비에서 별도의 고정 class→색상 대응표 대조를 추가해 catalog 변경도 검사한다. 보호 기준을 담은 기대값 변경은 별도로 검토한다. 스크린샷 저장은 자동 이미지 비교가 아니며 현재 그렇게 표현하지 않는다.

### 10.2 변경 종류별 필수 확인

| 변경 | 필요한 확인 |
| --- | --- |
| 문서만 | 링크·명령·현재 상태 정확성, runtime diff 없음 |
| 순수 선택/배치/측정 | 기존 검사 + 실제 실패를 잡는 작은 `assert` 기반 검사 |
| viewer props/수명주기 | 위 검사 + A/B 빠른 교체·실패·재시도·정리 + Web/Desktop 기존 조작 |
| scene/입력/스타일 | Web/Desktop 실제 선택·회전·hover·preset + 시각 기준 + 프레임/idle |
| preload/protocol/IPC | sender·경로·입력 검증, 취소/정리, 기존 sandbox·번들 자산 확인 |
| packaging/native 의존성 | production build + ASAR smoke + 실제 설치/업데이트/재실행/제거 범위 확인 |
| reader/Overlay/측정 연결 | 알려진 합성 공간·좌우·단위와 실제 지원 샘플, 손상·누락·취소·큰 입력 |
| 저장/동기화 | 실패 주입, 중복·재시작·취소, 원본/완료 결과 보존, 권한 검사 |

검사는 변경한 의미와 실패 경계를 확인한다. 함수 구현을 그대로 복사한 검사나 모든 컴포넌트를 위한 새 프레임워크를 만들지 않는다. 실패한 테스트의 기대값을 무조건 새 구현에 맞춰 바꾸지 않는다. 새 결과를 허용하려고 기존 데모 hash/색상/애니메이션 기준을 삭제하지 않는다.

### 10.3 실제 조작 smoke 순서

1. 기존 데모를 Web과 Desktop에서 열고 기본 24개·로고·색상·카메라·측정 Demo 표시를 확인한다.
2. Femur 선택 → Posterior 그룹 → 근육 추가 → 개별 해제 → 배경/Esc 해제. 숨김·격리·Reset도 확인한다.
3. Explode/Assemble, 분해 중 선택/해제, 우클릭 회전·다른 선택·복귀, 캔버스 밖 pointer release를 확인한다.
4. 환자 좌우 hover, 네 사분면·경계 위치, Class/Muscle preset, 키보드/동작 감소 설정을 확인한다.
5. 모델 실패·재시도, 창 resize·최소화·복원, idle 및 움직일 때 pacing을 확인한다.
6. 새 기능의 정상/실패 시나리오를 수행하고 기존 데모로 돌아와 1–2번을 반복한다. 자동화할 부분은 영향을 받은 경로부터 추가한다.

Web 반응형 확인 크기는 기존 기록의 1440×900, 390×844, 320×568, 667×375를 재사용한다. Desktop은 실제 창 크기와 최소 크기 800×600을 확인한다. 실제 터치 장비의 입력/성능은 마우스 기반 검사와 구분한다.

## 11. Git·검증 기록·rollback

### 11.1 보존된 기준

현재 동작을 담은 기준은 `eca2152`다. GitHub의 `design/marimo-glass` 브랜치에 올라갔다. `main`과 자동 병합된 것으로 간주하지 않는다. `release/`의 exe와 `outputs/`의 화면/성능 보고서는 Git에 포함되지 않는다. 소스 push는 설치 파일 Release 게시와 별개다.

2026-09-26 기준 소스에서 `npm run check`, `npm test`, `npm run test:desktop` 통과를 확인했다. Desktop smoke의 renderer 오류는 0이었고 관측 수치는 8절에 기록했다. 앞선 패키징 작업에서 NSIS 생성과 ASAR smoke도 통과했다. 이번 문서 작업에서 새 설치/업데이트 시나리오를 검증한 것은 아니다.

색상 보호 검사를 추가한 뒤 `npm test`를 다시 통과했고, 별도 Node 프로세스에서 Femur 색상만 메모리상 변경했을 때 새 assertion이 실패하는 것도 확인했다. 개발 준비 변경과 `eca2152`를 비교해 앱 코드·정적 자산·Desktop 실행부·의존성·빌드 설정의 diff가 없음을 확인한다.

### 11.2 후속 작업 시작과 종료

```powershell
# 작업 전: 현재 수정사항과 기준을 확인한다.
git status --short
git log -3 --oneline

# 공유하는 runtime 변경 시 실행한다. 각 명령이 실패하면 다음 배포 단계로 진행하지 않는다.
npm run check
npm test
npm run build

# Windows에서 renderer/Desktop에 영향이 있을 때 실행한다. 내부에서 Web build도 수행한다.
npm run test:desktop

# 패키징에 영향이 있을 때만 새 패키지를 만든다.
npm run desktop:dist
npx electron scripts/validate-desktop.cjs release/win-unpacked/resources/app.asar

# 커밋 전 파일 범위와 실제 diff를 확인한다.
git diff --check
git diff --stat
git diff --cached --name-only
```

`test:desktop`을 실행했다면 같은 소스에 대한 `npm run build`를 불필요하게 반복할 필요는 없다. Windows GUI 검사는 테스트 창을 열고 닫는다. 실행 중인 사용자 앱이나 다른 Electron/분석 프로세스를 일괄 종료하지 않는다. 패키지 파일이 잠겨 있으면 해당 앱을 확인해서 정상 종료한다.

테스트 로그는 변경한 commit/source 상태·장비·조건과 연결한다. 같은 이름의 `outputs/desktop-check/report.json`은 다음 실행에서 덮어쓰므로 성능 비교 전 별도 사본을 보관한다. 보고서에 포함되지 않은 장면/장비까지 검증 완료라고 쓰지 않는다.

기능 변경은 기준 브랜치에서 작은 작업 브랜치를 만들어 진행하고 통과한 변경만 통합한다. 기준 확인은 별도 `git worktree`로 과거 커밋을 읽는 방식이 안전하다. 되돌릴 때는 영향을 확인한 기능 커밋을 `git revert`하고 검사한다. 공유 브랜치를 force push하거나 작업 디렉터리를 `reset --hard`/`clean`으로 비우는 절차를 기본으로 쓰지 않는다.

저장 기능이 생긴 뒤에는 code revert만으로 결과 schema가 되돌아가지 않는다. 원본/완료 결과는 그대로 보존하고, schema 변경 전 이전 앱의 읽기 가능성과 데이터 복구 절차를 별도로 검증한다.

### 11.3 각 변경의 완료 체크

- [ ] 요구사항 ID와 이 변경에서 완료할 사용자 동작이 명확하다.
- [ ] 수정 함수의 호출자, 공유 Web/Desktop 경로, 영향을 받는 B01–B14를 확인했다.
- [ ] 필요한 최소 파일만 수정했고 원본 데이터·palette·데모 GLB·의존성의 무관한 변경이 없다.
- [ ] 새 상태의 소유자, 취소/실패/해제 처리, Demo/실제 데이터 구분이 있다.
- [ ] 관련 검사 통과 및 실제 UI 확인 범위를 기록했다. 미실행 검사를 통과로 쓰지 않았다.
- [ ] 기존 데모로 복귀 가능하며 회귀가 있으면 통합/배포를 중단했다.
- [ ] 결과 저장 변경이면 이전 완료 결과의 재열람·복구 방법을 확인했다.
- [ ] 현재 구현 상태와 다음 단계의 미완료 사항을 문서에 갱신했다.

## 12. 단계별로 결정할 항목

| 결정 시점 | 필요한 자료/선택 | 현재 상태 |
| --- | --- | --- |
| P1 | 기존 classification/segmentation/계산의 호출 방법·출력·지원 조건 | 사용자가 보유한다고 설명, 저장소에 실행 연동 없음 |
| P1 | 첫 입력 형식·modality·부위, 실제 class/side/좌표 대응 | 대표 입력/정답 출력 필요 |
| P3–P4 | 제공 예정 HTML, metadata JSON 연결 키, reader/MPR 도구 | 기능 참고용, 스타일은 현재 EXMO 유지 |
| P4 | 고정 preview 중 다른 hover의 표시 정책 | 미결정 |
| P5 | 로컬/서버 중 첫 실행 경로, GPU·RAM·VRAM 최소 조건 | 현재 뷰어 RTX 3050 실행 결과로 추론 요구를 대신하지 않음 |
| P5 | 분류 결과 수동 수정 허용 범위, 최종 분석 시작 동작 | 명시적 분석 버튼 제안 |
| P6 | 지방 지표의 방법·단위·분포 영상 유무, 저장·보존 위치 | 실제 계산 출력 확인 후 결정 |
| P7 | 양쪽 class/한쪽 구조 비교, 배경/Esc 해제 순서, 실제 축척 기준 | 6.3절은 세부 UX 제안 |
| P8 | 회원 유형·소속·공유 권한, 서버 전송 범위·삭제/보존 | 미결정 |
| 운영 배포 | 코드 서명·업데이트, 모델 실행물 배포/라이선스, 다른 OS | 현재 Windows 개발 패키지와 분리 |

이 항목들은 해당 단계의 개발 의존성이다. 지금 문서화를 마치기 위한 추가 승인 요청이 아니다. 자료가 없는 동안 합성 fixture·실패 경계 검증은 준비할 수 있지만 실제 기능 검증을 대신할 수는 없다.

## 13. 다음 개발 작업에 사용할 요청 형식

```text
기준: docs/EXMO_DEVELOPMENT_READINESS.md와 현재 Git 상태 확인.
대상: P번호 / R번호. 이번 변경에서 완료할 동작 한 가지를 적는다.
입력: 사용할 실제/합성 fixture와 예상 출력, Demo 여부를 적는다.
범위: 필요한 수정 파일과 공유 호출 경로를 먼저 확인한다.
보존: 영향을 받는 B번호, 기존 단일 데모/Web/Desktop 동작을 명시한다.
검증: 정상 1개, 핵심 실패 1개 이상, 관련 기존 회귀 검사와 실제 조작 확인.
금지: 무관한 리팩터링, palette/재질 변경, 모든 의존성 업데이트,
      실제 결과의 Demo fallback, 원본/완료 결과 덮어쓰기.
완료: 작은 diff, 검사 근거, 미완료 범위, 되돌릴 수 있는 커밋.
```

바로 다음 구현은 P0의 부족한 검증을 필요한 만큼 보강하고 P1의 실제 출력 계약을 확인하는 것이다. 전체 폴더를 먼저 재구성하거나 기존 viewer를 새 프레임워크로 다시 만드는 작업은 필요하지 않다.

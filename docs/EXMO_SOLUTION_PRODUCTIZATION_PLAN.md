# 솔루션별 제품화 구현·검증 계획

기준: 2026-10-17, `d474eea`. [설계 본문](EXMO_SOLUTION_PRODUCTIZATION_DESIGN.md)의 실행 계획이다. 설계 기준점은 `f790036`이며, `feat/solution-productization`에서 P0의 기준 기록과 P1의 registry·로컬 결과 ID, P2의 솔루션별 권한 경계, P3의 선택 설치·공용 Viewer, P4의 계정·운영 승인, P5 기본 결과 게시와 P6 Desktop 홈·서버 열람을 로컬 구현했다. 실제 통과 범위와 남은 검증은 [P1 구현 기록](EXMO_SOLUTION_P1_IMPLEMENTATION.md), [P2 구현·전환 기록](EXMO_SOLUTION_P2_IMPLEMENTATION.md), [P3 구현·검증 기록](EXMO_SOLUTION_P3_IMPLEMENTATION.md), [P4 구현 기록](EXMO_SOLUTION_P4_IMPLEMENTATION.md), [P5 구현 기록](EXMO_SOLUTION_P5_IMPLEMENTATION.md), [P6 구현 기록](EXMO_SOLUTION_P6_IMPLEMENTATION.md)을 따른다. 실물·운영 배포 검증, P5의 대표 영상 승인 및 P7~P8, acceptance matrix 전체가 완료된 것은 아니다.

## 1. 작업 범위와 보존 대상

완료 목표는 한 앱에서 장비 귀속 솔루션을 선택 설치·실행하고, 로그인한 사용자가 결과를 기관 서버에 게시하며 Web/태블릿에서 권한에 따라 열람하는 것이다. 모델 학습·정밀도/전처리 변경·새 진단 기능·결제 시스템·서버에서의 신규 segmentation은 포함하지 않는다.

지켜야 할 기존 동작:

- CT/MRI native 측정·좌우·좌표/단위, 3방향 slice/Overlay, 가운데 버튼 드래그.
- X-ray 환자/Study 그룹, Lt/AP/Rt 순서, 빠진 view 허용, ZIP/폴더/단일 파일 입력.
- 선택 우선의 표 row 클릭, 전체 선택, 패널 너비, 최대 3개 비교.
- 구조 선택/투명도, 전체 explode/assemble, 좌우 묶음, 구조별 회전·hover.
- 측정·Overlay 먼저 공개하고 3D는 후속 준비. Raw 보존, PP500/강화 후보 분리.
- 케이스별 오류·재시도, 진행 중 작업의 안전한 완료, 기존 결과 키/기관 복구.
- customer/internal authority·키·저장소 분리, Web에 분석 코드와 모델을 넣지 않는 경계.

## 2. 코드 변경 지도

| 영역 | 기존 경로 | 필요한 변경/신규 경계 |
| --- | --- | --- |
| 솔루션 목록 | `desktop/ui/main.tsx`, `desktop/ui/imaging.ts` | 고정 분석 목록 → registry 조회. `analysis`는 modality 의미 유지, solution/workflow ID 추가 |
| Registry | `desktop/solutions.cjs` (P1 구현) | 승인된 built-in adapter·입력·결과 계약·dependency 매핑; 별도 JSON 없이 고정 목록 유지; 서버 데이터로 임의 코드 실행 금지 |
| 홈/설치/상태 | `desktop/ui/main.tsx`, `license-status.tsx`, `workspace.css` | clinical table 유지, 상품 상태/설치/로그인/게시 분리. 상태 로딩은 항목별 실패 처리 |
| 실행/읽기 | `desktop/imaging.cjs`, `imaging-worker.py`, `model-runner.py`, `runtime_bootstrap.py` | main이 solution을 adapter/model로 해석. `variant/finalize/queueMesh`를 새 Mask 계산과 확정 결과 표시로 구분. reader runtime 독립. 기존 runner 계산 함수 유지 |
| 허가 | `desktop/security/license-protocol.cjs`, `license-client.cjs`, `runtime.cjs`, `model-package.cjs` | v3 파서·개별 entitlement·정확한 recipe/model 결합. v2를 별도 호환 경로로 유지 |
| Python 재검증 | `desktop/model_security.py`, `model-service.py`, `imaging-worker.py` | 새 run/lease schema, main과 같은 허용 조합 검사. grant를 믿고 modelId만 검사하지 않음 |
| 발급/원장 | `scripts/security/license-server.cjs`, `customer-admin.cjs`, `internal-admin.cjs` | 원장 migration 도구, 상품 발급·부분 회수·장비 이전; 운영 API와 CLI의 정책 공통화 |
| 패키지 | `scripts/security/package.cjs`, `payload.cjs`, `desktop/security/payload.cjs`, `main.cjs` | 선택형 signed manifest, dependency closure, staging/journal, use-before-verify 방지 |
| 로그인 | 신규 `desktop/security/account.cjs`, `desktop/ui/account.tsx` | main OIDC flow·OS 보호 token, renderer에는 계정 DTO만. license client와 수명 분리 |
| IPC | `desktop/preload.cjs`, `desktop/ui/imaging.ts` | 좁은 solution/install/account/publish API. 기존 origin/frame/입력 검증 유지 |
| 결과 계약 | `desktop/result-identities.cjs` (P1 구현), 게시 snapshot은 P5 | 로컬 origin/revision은 구현. 원문 contentDigest·게시 allowlist·전송 manifest·최종 사본 privacyReview는 P5 |
| 전송 | 신규 `desktop/sync.cjs`와 전용 outbox 저장소 | 게시자/org/origin 고정, 현재 uploader와 attemptId 분리. 재개/재암호화/취소/CAS; imaging 실행 queue와 독립 |
| 로컬 보호 | `desktop/security/result-storage.cjs`, `artifact_store.py` | 기존 읽기/복구 보존. 게시용 키 wrapping을 추가하되 전체 로컬 DEK를 공개하지 않음 |
| 서버 | 신규 서버 패키지(배치 경로는 구현 시 확정) | OIDC 검증, org/ACL, 결과 DB/object store, mask worker 격리, 감사/운영 |
| 원격 viewer | `app/page.tsx`, `scene.tsx`, 결과 UI 공통 부분 | demo와 실제 원격 result route 분리, desktop IPC 없는 viewer adapter, touch UX |
| 문서/릴리스 | README, 보안/전송 runbook, 새 migration 기록 | 어느 schema/client/package 조합을 지원하는지 명시, 실제 시험 evidence 연결 |

신규 클래스/서비스는 위 경계가 실제로 필요할 때만 만든다. `ct/mri/xray` 조건문을 여러 파일에 복사하거나 generic plugin framework, 상품마다 별도 앱/서버를 만들지 않는다. registry·권한 판단·전송 상태를 UI 컴포넌트 안에 구현하지 않는다.

## 3. 단계별 구현 순서

### P0 — 기준 고정·계약 fixture

- 현 branch/ASAR/payload digest/실제 결과 5종/현재 UI 회귀 기록을 release baseline으로 보존한다.
- solutionId 매핑, 현재 legacy AP-only/LAT-only 권한, runtime 의존성, 결과 schema를 fixture로 만든다.
- 가중치·recipe·표시 단위·좌우 계산·원본 복원은 변경 목록에서 제외한다. 실제 분리 과정에서 변경이 필요하면 별도 diff/검증으로 명시한다.
- 종료 조건: 각 기존 결과를 새 ID로 해석할 수 있고 원본 파일은 변하지 않음. 설치 조합/권한/전송 테스트 행렬 확정.

### P1 — Registry·결과 ID 확장

- 기존 3개 workflow를 그대로 adapter로 등록한다. 화면과 IPC에 solutionId를 통과시키되 계산 경로는 유지한다.
- legacy read adapter로 기존 `analysis` 결과를 열고 새 결과에 solution/workflow/schema/provenance를 기록한다.
- 생성 시 고정되는 originStoreId/originResultId/analysisRevision을 별도 sidecar에 보존한다. 복구/재게시/Raw 복귀 때 새 ID를 만들지 않는다. 아직 publish하지 않은 legacy 결과도 반복 migration 시 같은 매핑을 사용한다.
- 미래 동일-modality 상품 fixture를 넣어 다른 CT 상품의 입력/결과/권한이 섞이지 않는지 확인한다.
- 종료 조건: 고정 3개 UI 상수 제거, 기존 5종 기능 및 선택·비교 회귀 통과. 고객에 무권한 generic runner를 노출하지 않음.

### P2 — 솔루션별 권한·발급

2026-10-18: 권한/발급/worker/확정 결과 경계의 소프트웨어 구현과 검증을 반영했다. [P2 구현·전환 기록](EXMO_SOLUTION_P2_IMPLEMENTATION.md)을 따른다. 실제 YubiKey, 운영 서버, 새 설치본 검증은 남아 있다.

- v3 lease/run schema와 server transaction, 개별 상품 기간·회수·허용 digest를 구현한다.
- main/Python shared fixtures로 동일 허용/거부 판정을 확인한다. 내부용도 상품 제한을 시험한다.
- model-run과 새 Mask 후처리의 result-mutation 허가를 분리하고 main/결과 worker 양쪽에서 검사한다. 확정된 Mask의 표시 mesh 재시도는 reader에서 처리하며 새 모델 키/유효 상품 entitlement를 요구하지 않는다. Mask/측정/좌우 변경을 읽기로 위장하는 요청은 거부한다.
- 관리 CLI로 먼저 발급할 수 있게 하고, 계정 관리 UI는 P4에서 연결한다. v2 호환 계약과 v3 전환 계약을 혼동하지 않는다.
- 종료 조건: CT-only license로 MRI/X-ray/공유 모델 우회 불가. MRI만 만료·회수해도 CT는 동작. 대기/진행 job 정책 통과.

### P3 — 선택 설치·안전한 업데이트

구현 및 실제 검증 범위: [P3 구현 기록](EXMO_SOLUTION_P3_IMPLEMENTATION.md). 폴더/NAS 서명 media 경로를 구현했으며, 실물 동글·운영 서버·새 PC acceptance는 별도 완료가 필요하다.

- reader/security runtime을 항상 이용할 수 있는 공통 패키지로 분리하고 추론 환경의 실제 dependency graph를 산출한다.
- 모델 제거 후에도 확정 snapshot과 과거 mesh recipe의 공용 reader 의존성을 보존한다. 확정 snapshot이 없는 중단 추론은 재추론 허가가 필요하다.
- signed selection manifest, installer staging/journal/atomic pointer, 실행 version pin, 공유 runtime 참조, rollback 정책을 구현한다.
- 작은 검증된 shell은 먼저 열고 선택 상품은 실행 전에 closure 전체를 검증한다. 검증 생략/mtime 캐시로 속도를 만드는 방식은 제외한다.
- 종료 조건: CT만/MRI만/X-ray만/혼합/모두 설치·제거·중단 복구 통과. 보호된 고객 경로에서 5개 route 실제 입력→출력 기능 시험. 원래 환경과 비교가 필요한 import/수치 변경은 원인별 검사.

### P4 — 계정·기관·초기 설정

2026-10-18: 계정/등록/EXMO 운영 승인과 고객별 솔루션 권한의 로컬 구현·검증을 진행했다. 적용 범위, 서버 설정과 남은 검증은 [P4 구현 기록](EXMO_SOLUTION_P4_IMPLEMENTATION.md)을 따른다. 고객의 키 하나·PC 하나 아래 여러 솔루션 권한을 추가하며, 키 필수/내부용 면제 승인은 EXMO 운영자만 수행한다. 실제 IdP/HTTPS/실물 동글 운영 배포는 아직 남아 있다.

- OIDC provider 연결, 브라우저 PKCE, membership/workspace, 계정/장비 역할 분리.
- 첫 등록은 관리자 로그인/키+PC 증명, 평상시 분석은 유효 장비 lease로 동작한다.
- login/logout이 imaging worker·license cache·결과 DEK를 초기화하지 않도록 경계를 검증한다.
- 종료 조건: 로그인 장애/로그아웃 중에도 유효 로컬 분석·열람 가능, 클라우드 게시/조회는 차단. 잘못된 기관/계정으로 장비·데이터를 이전할 수 없음.

### P5 — 결과 게시·보호 저장·복구

2026-10-18: 수동 게시 UI, 암호화 outbox/multipart 재개, 기관·PC·게시자 검증, 서버 private verifier, 측정/QC 우선 commit과 후속 GLB, CAS/idempotency/tombstone을 구현·검증했다. [P5 구현 기록](EXMO_SOLUTION_P5_IMPLEMENTATION.md)을 따른다. 대표 Overlay는 픽셀 검토·최종 사본 승인 기능 전까지 전송하지 않는다. 실제 배포와 전체 acceptance 완료는 아니다.

- result publication snapshot과 contentDigest, 별도 암호화 attempt/session/outbox, commit/CAS/idempotency/권한 재검사를 구현한다. origin 소유/이관과 tombstone을 현재 uploader와 분리한다. 첫 성공 commit에 workspace를 고정하고 재시도·조회·중복 반환·첨부에서도 대상 일치를 검사한다. 다른 대상은 409로 거부하며 원래 workspace/결과의 비공개 정보를 오류에 노출하지 않는다.
- 기본 수동 게시. metrics/QC 준비 시 게시, 3D는 같은 revision의 후속 artifact로 첨부한다.
- 기본 전송은 Mask·측정/QC 요약·GLB·승인 대표 영상으로 한정한다. 전체 확률/entropy/disagreement 배열은 제외하며, 없는 데이터를 공유 때문에 재생성하지 않는다.
- 최종 대표 영상의 픽셀 식별정보 확인/비가역 제거/승인 정보를 사본 hash에 결합한다. 영상 미승인 시 그 artifact만 제외하고 나머지를 게시할 수 있게 한다. 기관 정책·임상 QC 승인을 혼동하지 않는다.
- 서버에 결과 읽기용 projection을 만들고 native mask는 private worker 권한으로 제한한다.
- 종료 조건: 원본/키/평문 Mask 유출 없음, 네트워크/로그인/디스크/권한 오류에서 원본·완료 결과 유지, 재시도 중복 없음, 기관별 복구/삭제 시험 통과.

### P6 — 실제 홈 화면 통합

2026-10-18: Desktop 홈의 사용권/설치 상태 분리, 서버 결과 목록·읽기 전용 측정/QC/3D, 최대 3개 선택과 호환성 검사, 가명 Study 및 X-ray 방향 묶음을 연결했다. [P6 구현·검증 기록](EXMO_SOLUTION_P6_IMPLEMENTATION.md)을 따른다. 운영 서버·고객 설치본 검증과 Web/태블릿은 남아 있다.

- [화면 모형](prototypes/solution-home.html)의 상태와 실 backend readiness를 연결한다.
- 구매/설치/장비 상태와 계정/전송 상태가 독립적으로 보이고 row 주요 동작이 일관되게 작동하게 한다.
- surface와 page/로그인 복귀 경로를 분리한다. Desktop의 서버 결과 조회에서도 분석 메뉴·로컬 결과 복귀를 유지한다. 게시 완료는 서버 목록에 반영하고, 로그아웃 시 서버 목록을 숨긴다. 비교는 개수 외 quantity/unit/ontology/method/coverage를 선택·시작 시 검증하고 비호환 사유를 표시한다. 선택 해제는 항상 가능하게 한다. 행 선택 후 키보드 focus를 보존하고, 비교 중에도 별도 결과 열기/닫기와 선택 유지가 가능하게 한다.
- 일상 홈, 최초 설정, 솔루션 관리, 전송 현황, 최근 결과를 동일 스타일로 마무리한다.
- 종료 조건: 첫 진입부터 설치/분석/결과/게시까지 의사 사용자 흐름 검토. 키보드/고배율/좁은 창, 부분 실패와 재시도 통과.

### P7 — Web·태블릿 결과 viewer

- OIDC/BFF 기반 결과 목록/검색·viewer·최대 3개 비교, X-ray view 그룹, touch controls.
- metric/QC/3D/Overlay만 전달하고 manifest가 허용한 범위를 정확히 표시한다. stack 없는 결과에 slice 기능을 만들어 보이지 않는다.
- 기본 online-only; 브라우저 영구 PHI cache 및 분석 UI/runtime 부재 검사.
- 종료 조건: 허용된 다른 장치에서 동일 결과/단위/variant를 보고, 다른 기관·퇴사 사용자·조작된 artifact ID는 거부됨.

### P8 — 전환·고객 출시

- 기관/기존 라이선스·결과의 dry-run 매핑, 백업, migration, rolling compatibility, rollback 시험.
- 기존 7일 lease를 포함한 v2 종료 기간을 운영한다. 전환 중 v2 grant로 v3 상품 회수를 우회하지 못하게 한다.
- 실제 HTTPS 서버·OIDC·object store/KMS·코드 서명 설치본·실물 YubiKey 5C NFC·새 PC에서 통합 검증한다.
- 종료 조건: 아래 acceptance와 실제 하드웨어/운영 evidence가 모두 있음. 미검증 항목을 문서화만 했다고 완료 처리하지 않음.

## 4. Acceptance matrix

각 시험은 **입력 상태, 수행 동작, 기대 결과, 실제 결과, artifact/commit/장비**를 기록한다. 합성 예외·mock API·실제 하드웨어를 구분한다.

| ID | 검사 | 기대 결과 |
| --- | --- | --- |
| LIC-01 | CT-only, 3개 패키지 존재 | CT만 신규 분석 가능; MRI/X-ray 직접 IPC도 거부 |
| LIC-02 | MRI 만료/회수, CT 유효 | CT 정상, MRI 신규만 차단, 양쪽 기존 결과 열림 |
| LIC-03 | 미래 CT 상품 + 같은 modality | solution ID 교체·공유 모델 우회 거부 |
| LIC-04 | 다른 PC/키/기관 binding | 새 작업 거부, 기존 결과 손상 없음 |
| LIC-05 | 유효 grace/만료/시계 역행/구 sequence | 정책별 허용/거부, 재시작으로 유예 연장 안 됨 |
| LIC-06 | 대기 중 회수·실행 중 동글 제거 | 신규 case 거부, 승인된 작업은 안전 종료 |
| LIC-07 | recipe/model/runtime digest 변조 | main/worker 모두 거부, 공개 진단 번호 남음 |
| LIC-08 | internal token/issuer/customer 조합 | 고객에서 내부 권한 사용 불가 |
| LIC-09 | 3D 중단 후 재시작·상품 만료·동글/모델 없음 | 확정 Mask/recipe의 3D 복구·기존 GLB 열람 가능; 새 후처리/재추론은 거부 |
| LIC-10 | reader 요청에 임의 Mask/새 recipe/측정 변경 주입 | 읽기 경로에서 거부; 새 계산은 원본 revision/digest에 묶인 실행 허가 필요 |
| INS-01 | CT-only/MRI-only/X-ray-only + 복수 조합 | 정확한 closure만 설치, 실제 각 route 분석 완료 |
| INS-02 | 미설치 상품 | 홈 정상, 해당 행 설치 안내; 없는 모델을 손상으로 오인 안 함 |
| INS-03 | 공용 runtime을 쓰는 상품 1개 제거 | 나머지 상품 정상, 과거 결과 reader 유지 |
| INS-04 | 다운로드/검증/전환 중 전원 중단 | 다음 실행에서 완성된 이전/새 버전만 사용 |
| INS-05 | disk full/권한 거부/긴 경로/잠긴 파일 | 기존 버전·결과 보존, 해당 상품 오류 표시 |
| INS-06 | 변조/누락/추가 파일/junction/서명 불일치 | 실행 전 거부; 정상 독립 상품은 유지 |
| INS-07 | 실행 중 업데이트/rollback | 진행 job은 pin된 버전 유지, 회수 digest 재활성화 불가 |
| INS-08 | 오프라인 매체 가져오기 | 기발급 허가/정확한 digest만 사용; 최초 활성화는 온라인 |
| ACC-01 | 최초 로그인/취소/잘못된 state·nonce·redirect | 올바른 flow만 수락; callback/token 로그 노출 없음 |
| ACC-02 | refresh 동시 실행/재사용/만료 | 갱신 직렬화·재사용 감지, 재로그인 안내 |
| ACC-03 | 로그아웃/IdP 장애 | 로컬 분석/결과 보존, 서버 신규 게시/조회 차단 |
| ACC-04 | A 계정 outbox 중 B 로그인 | A queue를 B로 자동 게시하지 않음 |
| ACC-05 | A 기관 장비에서 B 기관 계정 | 등록/게시 org 조작 거부 |
| ACC-06 | 역할 제거/초대 전 계정/관리자만 계정 | 임상 데이터 접근권이 없는 역할의 조회 거부 |
| SYN-01 | 검토 후 Raw 게시 | 원본 제외, 같은 revision의 mask/metrics/QC/geometry만 전송 |
| SYN-02 | 지연/실패한 3D | metrics/QC 게시, pending/error 표시, 준비된 GLB만 후속 첨부 |
| SYN-03 | 강한 후처리/Raw 전환/재분석 | revision 분리, 이전 결과/Raw 보존 |
| SYN-04 | 중간 끊김/앱 재시작/동일 요청 반복 | resume/idempotency, 중복 결과 없음 |
| SYN-05 | 같은 idempotency key 다른 내용 | 409, 조용한 덮어쓰기 없음 |
| SYN-06 | upload 중 회수/로그아웃/다른 기관 변경 | commit 재검사; staging만 남고 사용자 결과에 안 보임 |
| SYN-07 | mask hash/크기/manifest 불일치 | commit 거부; 3D만 보고 완료 처리 안 함 |
| SYN-08 | quota 초과/서버 5xx | 전송 보류/재시도, 로컬 분석 정상 |
| SYN-09 | 생성 당시 로그아웃 | creator를 이전 사용자로 꾸미지 않음, 게시자는 서버 신원 |
| SYN-10 | 서버 삭제 후 오래된 PC 재접속 | tombstone으로 같은 revision 재게시 차단 |
| SYN-11 | 분석 계약 만료 후 기존 결과 게시 | 계정/저장 권한이 유효하면 가능; 장비 보안 회수는 별도 검사 |
| SYN-12 | 같은 결과의 새 DEK/nonce/암호문 재시도 | 새 attempt 허용, 같은 contentDigest/resultId 유지; 같은 attempt의 다른 내용은 409 |
| SYN-13 | complete 응답 유실·staging 만료·두 attempt 동시 complete | 상태 조회/새 session 후 결과 하나에 수렴; 채택된 암호문 덮어쓰기 없음 |
| SYN-14 | 동일 identity에 다른 Mask/측정/recipe | 409, 새 분석 revision 없이 내용 변경 불가 |
| SYN-15 | A에서 게시 → B로 복구 → 재게시/늦은 GLB | 같은 origin/resultId, uploader만 B로 변경; 위조 origin은 거부 |
| SYN-16 | 서버 삭제 → B 복구본/새 attempt/늦은 GLB 게시 | 안정된 origin/revision tombstone으로 거부; 자동 복구 안 됨 |
| SYN-17 | 확률 배열 없는 CT 결과·폴더 내 임시/원시 배열 존재 | 기존 Mask/측정/QC 정상 게시; 원시 배열/임시 파일 미전송·재추론 없음 |
| SYN-18 | 같은 origin/revision/content를 A 게시 후 B workspace로 재요청; 두 workspace 모두 권한 있음/기존 A 조회권 없음 | 대상 불일치 409, A 결과로 성공 반환·자동 공유·중복 생성 없음; A의 비공개 정보 미노출. 같은 대상 재시도는 ACL 재검사 후 수렴 |
| SYN-19 | 다른 workspace 두 attempt 동시 complete·응답 유실 후 상태 조회·늦은 attachment·삭제 후 재게시 | 첫 성공 commit의 대상만 고정, 다른 대상 거부. 상태 조회/첨부도 대상 검사; tombstone/귀속 유지 |
| DAT-01 | viewer API/네트워크/cache 검사 | 평문 Mask·확률 배열·모델·DEK 없음 |
| DAT-02 | org/객체 ID/서명 URL 변조 | 다른 기관 metadata와 artifact 접근 불가 |
| DAT-03 | 결과 키 복구/기관 이전 | 올바른 새 장비만 복구, 키 손실/오류 명시 |
| DAT-04 | 계정/솔루션 제거/앱 업데이트 | 로컬 결과 키·원본·기존 결과 유지 |
| DAT-05 | DB/object/key 백업 복원 | revision·ACL·회수 원장·읽기 결과 일치, 실패 명시 |
| DAT-06 | 픽셀에 합성 환자명/번호가 있고 header만 제거 | 영상은 미승인 상태, 정책별 사본 검사/픽셀 제거 전 게시 안 됨 |
| DAT-07 | 승인 영상의 bytes 변경·다른 hash 승인 복사 | 승인 재검사/거부; 원본·Mask는 불변. 영상 제외 시 다른 결과 게시 가능 |
| VIEW-01 | 5개 route와 Raw/후처리 결과 | 원본 계약의 단위/값/좌표/색상/좌우/variant 보존 |
| VIEW-02 | 1/2/3개 비교 및 X-ray 누락 view | 선택·독립 회전·그룹·순서 유지 |
| VIEW-03 | tablet 터치/좁은 화면/키보드 | hover 없이 상세 열람, 동작 버튼 접근 가능 |
| VIEW-04 | snapshot만 있는 결과 | 임의 slice/MPR 사용 불가를 명확히 표시 |
| VIEW-05 | unsupported 새 schema/adapter | 오해 가능한 결과 대신 업데이트 안내 |
| VIEW-06 | 라이선스 만료/동글 없음 | 허가된 서버 계정으로 기존 결과 열람 가능 |
| VIEW-07 | web build 검사 | 업로드·추론 IPC·Python·모델 bundle 없음 |
| VIEW-08 | remote 상단/본문 로그인·취소·세션 만료·잘못된 복귀 경로 | remote 결과 화면만 반환, Desktop 메뉴 부재 |
| VIEW-09 | 호환 2/3개·4개·단위/ontology/method/coverage 불일치·정보 없음 | 호환 최대 3개만 수치 비교; 사유 표시·해제 허용·시작 시 재검사 |
| VIEW-10 | 게시 완료 → Desktop 서버 결과 → 로그아웃/재로그인 → 분석 복귀; 별도 Web에서 조회 | 게시한 결과 표시, Desktop 메뉴/복귀 유지, 로그아웃 중 서버 목록 숨김, Web에는 분석 메뉴 없음 |
| VIEW-11 | 비교 행 Enter/Space 선택·해제·거부, 결과 열기 버튼 → 닫기 | 같은 행 focus 유지; 버튼은 선택을 토글하지 않고 열기, 닫으면 선택 목록과 버튼 focus 유지 |
| MIG-01 | 기존 v2/legacy 결과 | 기존 파일/키 변경 없이 열림, 새 필드 read adapter |
| MIG-02 | legacy AP-only/LAT-only | 완전 X-ray 상품으로 무승인 승격 안 됨 |
| MIG-03 | v3 전환 후 구 v2 client | 전환 정책대로 제한, 부분 회수를 v2로 우회 불가 |
| MIG-04 | 기존 전체 payload/새 선택형 payload | schema별 명시적 지원, 구 verifier는 새 schema 거부 |
| MIG-05 | dry-run/실패/rollback | 백업 복구 가능, 일부분만 이전된 원장 발급 금지 |
| PERF-01 | cold/warm shell 시작 | 분석 무결성 검증을 줄이지 않고 홈 준비 시간 별도 측정 |
| PERF-02 | 전송+분석+slice scroll | bounded memory, 분석/Overlay 회귀와 업로드 지연을 각각 측정 |

## 5. 성능과 검사 범위

수치 목표는 구현용 잠정 기준이다. 동일 PC·데이터·driver·검사 범위에서 확인한 뒤 출시 기준을 확정한다.

- 공통 홈 표시: 모델 전체 hash를 기다리지 않는 경로에서 5초 이내 목표. 실제 reader/security 패키지 크기와 cold I/O에 따라 조정 근거를 기록한다.
- 사용자가 상품을 열면 `검증 중`과 진행 상태를 즉시 표시하고 검증 전 실행 금지. “빠른 UI”를 “모델 준비 완료”로 보고하지 않는다.
- 전송은 추론 memory budget과 독립된 제한된 buffer를 사용한다. 결과 공유 때문에 기존 slice/Overlay 지연이 증가하면 먼저 전송 동시성과 생성 작업을 제한한다.
- Web/태블릿은 실제 목표 기기에서 최초 측정/GLB 표시, 회전 FPS, peak memory를 측정한다. 저해상도 표시 mesh의 시각 품질과 native 측정 보존을 각각 검사한다.
- 패키지 분리/작업 허가의 첫 통합 검사는 CT·MRI·AP·LAT-LT·LAT-RT 실제 입력→출력까지 한다. UI 텍스트/목록 변경마다 GPU 추론을 반복하지 않는다.
- 모델 가중치·전처리·정밀도·recipe/좌표 처리에 변화가 없으면 기존 baseline과 필요한 기능 회귀를 사용한다. 수치 경로가 바뀌면 그 변경의 정확한 출력 비교를 별도로 수행한다.

현재 재사용 가능한 검사: `npm test`, `npm run check`, `npm run test:language`, `npm run test:license`, `npm run test:model-security`, `npm run test:artifact-security`, `scripts/validate-analysis-worker.cjs`, `validate-early-results.cjs`, `validate-analysis-pipeline.cjs`, `validate-zip-import.py`, `validate-imaging.py`, `validate-results-workflow.cjs`, `validate-error-ui.cjs`, `scripts/security/check-internal-package.cjs`. 실행 경로/fixture는 새 계약에 맞게 업데이트해야 한다. 이 목록을 모두 새 기능 검증에 충분한 것으로 간주하지 않는다.

## 6. 운영자가 준비할 항목과 기본값

| 항목 | 기본 설계 | 실제 배포 전 확정/제공 |
| --- | --- | --- |
| 판매 상품명·SKU | 3개 안정 ID, bundle은 원장에 풀어 기록 | 판매명, 기간/영구, 유지보수 조건 |
| 장비 정책 | 키 1개 + 설치 신원 1개 | 기관의 Windows 사용자 프로필 운영 방식 |
| 로그인 | OIDC, 기관 초대 기반, Desktop은 cloud 연결용 | 도메인/IdP/메일 발송/초대 담당자, 관리자 MFA |
| 결과 게시 | 수동 검토 후 게시 | 기관 데이터 처리 승인/식별정보 허용 필드 |
| 원격 영상 | metrics/QC/3D/대표 Overlay | 전체 slice 필요 여부·표시 영상 전송 범위 |
| 저장·복구 | 기관 소유, private objects, 결과별 암호화 | 서버 위치·storage quota·보존/삭제·KMS/백업·RPO/RTO |
| 렌더링 | 표시용 GLB 전달 | geometry 제공 금지 기관은 별도 server rendering 정책 |
| 배포 | 서명된 app + 선택 패키지, profile 격리 | 서버 SSH/TLS/DNS, 코드 서명, 배포 채널 |

이 항목들은 설계 누락이 아니라 기관/사업 정책의 설정 지점이다. 기본안으로 개발할 수 있으나 실제 환자 데이터 전송과 고객 배포 전에 해당 운영자가 값을 승인해야 한다. 지금 사용자에게 원본 영상이나 개인키 제출을 요구할 이유는 없다.

## 7. 이번 설계 작업의 완료 확인

- [x] 현재 code/strict protocol/runtime/홈/결과 계약을 읽고 변경 경계를 정리했다.
- [x] 사용자 확인(PC 1대 귀속, 계정의 원격 결과 공유 목적)을 반영했다.
- [x] 솔루션 확장·선택 설치·동글/계정 분리·홈/초기 설정·원격 결과·Mask 보호·오프라인·전환을 설계했다.
- [x] 구현 순서·기존 파일/caller/fixture·실패 시나리오·출시 gate를 명시했다.
- [ ] 제품 구현과 실제 서버·동글·설치본 통합 검증 — 다음 개발 작업이다.

홈 HTML은 가상 기관/가상 결과만 쓰는 설계 모형이다. 로그인/설치/분석/업로드는 실제로 실행하지 않으며 제품 구현 증거로 사용하지 않는다.

## 8. 설계 검토 기록

2026-10-17에 현재 코드와 요구사항을 대조했다. 이 표는 설계 범위의 충족 여부이며 제품 기능 통과 기록이 아니다.

| 요구사항 | 설계 위치 | 검토 결론 |
| --- | --- | --- |
| 한 앱, 솔루션별 판매·추가 확장 | 본문 §3, §6 | modality와 solutionId 분리, 검증된 adapter 및 패키지 의존성 명시 |
| 키 1개, PC 1대 귀속 | §4 | 설치 신원·동글 결합, 관리자 이전, 오프라인 회수 지연과 Windows 사용자 범위 명시 |
| 계정 로그인 목적 | §5 | 장비 실행 권한과 기관 데이터 권한 분리, 로그아웃 후 유효 로컬 분석 유지 |
| 홈/첫 설치 화면 변경 | §7 및 HTML | 일상 작업 표·초기 등록 분리, 상품별 상태/행 동작, 비교 선택 우선 |
| 원본 로컬, 결과 서버 보관 | §8–9 | 수동 게시, 보호 Mask·측정/QC·3D·선택 Overlay, 결과별 키·revision·재시도 |
| Web/태블릿 열람 | §10 | 읽기 전용, 기관 ACL, 호환 결과 비교, 원본 미전송에 따른 Overlay 범위 제한 |
| 기존 동작 보존 | 본 계획 §1–5 | 숫자 계산 경로 보존, legacy 결과/lease 전환, 혼합 상품·설치 장애 격리 |
| 구현 가능한 순서와 검증 | 본 계획 §2–6 | 기존 caller/검사 지도, 단계별 gate, 서버·실물 통합 검증을 후속 작업으로 구분 |

검토 중 보완한 항목: 선택 설치 전에 CT에 묶인 공용 reader 분리, 기존 AP-only/LAT-only 계약의 무단 권한 확대 방지, JS/Python strict schema 동시 전환, 상품 만료와 과거 결과 게시 권한 분리, 승인된 장기 작업과 짧은 입장 허가의 수명 분리, 원본 미전송 상태에서 임의 slice Overlay를 약속하지 않는 경계.

### 화면 모형 검증

[검사 스크립트](prototypes/check-home.cjs)로 Electron offscreen 실행: **15개 확인 통과, 외부 요청 0건**.

- 구매 목록/실행 상태, 키보드 행 열기, 가상 설치, 상태 변경 시 이전 알림 정리.
- 로그아웃 후 로컬 분석 유지, 계정 화면 진입과 가상 로그인 복귀.
- 오프라인 신규 다운로드 차단, 동글 없는 신규 분석 차단과 기존 결과 유지.
- MRI 만료/X-ray 설치 오류가 CT에 영향을 주지 않는 화면 상태.
- 명시적 가상 게시, 첫 등록 화면, 비교 모드 행 선택, 원격 화면 분석 진입점 부재.
- 820 px 태블릿 너비에서 바깥쪽 가로 넘침 없음.

홈·로그인·부분 장애·태블릿 결과 화면 4장을 생성하고 시각적으로 확인했다. 모형 테스트이며 실제 권한 강제, OIDC, 설치 서명, 서버 전송, 실물 YubiKey 검증을 대신하지 않는다.

저장소 루트 PowerShell 재현 명령:

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
node node_modules/electron/cli.js docs/prototypes/check-home.cjs
```

검사 결과와 화면은 `outputs/solution-design-check/`에 저장된다. `verification.json`은 검사 당시 HTML SHA-256과 통과 항목을 담는다. 제품 소스·모델·기존 설정은 변경하지 않았으므로 이번 설계 작업에서 GPU 재추론이나 전체 제품 테스트를 반복하지 않았다.

## 9. 추가 재검토 반영

[재검토 보고서](EXMO_SOLUTION_PRODUCTIZATION_REVIEW.md)의 1–5번을 설계/구현 gate/위 acceptance에 반영하고 6–7번은 모형에서 수정했다. 위 15개 기록은 최초 검사다. 후속 검사는 웹 재로그인/취소/복귀 경로와 비교 호환성/상한/해제/시작 시 재검사를 포함한다. 최신 실행 결과와 검증 범위는 리뷰의 반영 기록 및 `outputs/solution-design-check/verification.json`을 따른다. 실제 서버·권한·암호화 업로드의 acceptance는 여전히 제품 구현 단계에서 수행해야 한다.

두 번째 재검토의 5건도 반영했다. 게시 대상 workspace 고정/충돌은 SYN-18–19의 실제 서버 gate이며 아직 실행하지 않았다. 게시 결과의 목록 반영, Desktop 내 서버 조회/로그인 복귀, 키보드 focus, 비교 중 결과 열기는 모형에 구현하고 회귀 검사에 추가했다. 제품 분석 코드·모델에는 변경이 없다.

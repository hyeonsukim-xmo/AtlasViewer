# P6 Desktop 홈·서버 결과 열람

기준: 2026-10-18, `feat/solution-productization`. P5 기본 게시 이후의 Desktop 연결이다. 운영 서버 배포, 웹/태블릿 클라이언트, 대표 Overlay 게시, 실물 YubiKey 및 고객 설치본 검증의 완료를 의미하지 않는다.

## 사용자 흐름

- 기존 clinical table과 3D Viewer를 유지한다. 홈에서 설치 상태와 사용권을 구분하고, 사용 가능한 구매 솔루션을 먼저 표시한다. 미보유 항목은 일상 홈에서 숨긴다.
- 상태 확인 전에는 신규 작업으로 들어가지 않는다. 만료·중지·장비 인증 필요는 라이선스 관리로, 미설치·복구 필요는 기존 솔루션 관리로 안내한다. 결과 목록은 별도로 유지한다.
- 초기 승인이 필요한 설치본에는 계정·장비 등록 진입점을 표시한다. Windows 관리자 권한으로 고객용 키 정책을 변경하지 않는다.
- `서버 결과`에서 현재 기관/workspace의 최신 200건을 검색하고 열람한다. 목록은 진입·수동 갱신·15초 주기로 다시 확인한다. 다른 PC에 원본이 없어도 게시된 측정·QC·3D를 읽을 수 있는 경로다. 실제 다른 PC 설치 시험은 별도다.
- 일반 모드 행 클릭은 열기, 비교 선택 모드에서는 선택 토글이다. 독립 `결과 열기` 버튼을 유지하며, 닫으면 선택 및 원래 버튼의 키보드 포커스를 복원한다. 최대 3개, 해제는 항상 가능하다.
- 원격 결과는 고정 snapshot이다. 로컬 후처리/재추론/공유/이미지 저장 IPC를 실행하지 않는다. 원본과 Overlay가 게시되지 않았으므로 slice 조작을 제공하지 않는다.
- 계정 변경·로그아웃은 서버 결과와 3D 핸들을 지운다. 역할 회수는 각 서버 요청에서 재검사하고, 화면은 다음 갱신에서 닫는다. 이미 전달된 화면/바이트를 원격으로 회수할 수 있다는 의미는 아니다.
- 서버 오류와 로그인 장애가 로컬 분석/결과 저장소를 초기화하지 않는다. Desktop 분석 메뉴와 복귀 버튼은 원격 열람 중에도 유지한다.

## 케이스·Study와 비교 계약

`publication-outbox/study-links.bin`은 Windows 보호 저장소에 들어가는 로컬 가명 매핑이다. 서버에는 무작위 `caseId`, `studyId`, `acquisitionId`만 보낸다. 환자명/환자번호/Study UID/촬영일/로컬 경로는 보내지 않는다. 가명은 익명화 보증이 아니다.

- 기관 발급처+환자번호가 있을 때만 같은 케이스를 연결한다. Study UID가 있으면 해당 Study, 명시적으로 환자·촬영일을 배정한 경우에는 유효한 날짜를 포함한 배정을 사용한다. 날짜만 같다고 별도 촬영을 병합하지 않는다.
- 정보가 없으면 개별 입력으로 분리한다. 파일 이름으로 환자나 Study를 추측하지 않는다. X-ray는 확인된 Study 안에서 LT → AP → RT로 표시하며 빠진 view는 미게시로 표시한다. 같은 방향이 여러 개면 목록에 모두 남고, 묶음 열기는 방향별 최신 게시본을 연다.
- 기존 게시 결과의 context가 이미 있으면 서버 값을 재사용한다. 새 PC로 복구한 동일 origin의 재게시가 새로운 가명으로 기존 귀속을 덮어쓰지 않는다. 기관 전체의 환자 마스터/다른 origin 간 자동 환자 매칭은 구현하지 않았다.
- 로컬 결과가 있는 PC에서는 현재 계정의 outbox와 로컬 결과를 대조해 이름을 화면에만 표시한다. 그 이름을 서버 조회/게시 요청으로 전달하지 않는다.
- context는 분석 내용 digest와 별도다. 최초 연결 이후 다른 내용으로 바꾸는 요청은 409다. 게시 당시 기관/workspace/원본 저장소 승인과 분석 revision을 유지한다.

수치 비교는 단위/측정 종류, label·구조 ontology, workflow/촬영 방향, 확인된 native 촬영 범위를 선택 후와 시작 시 재검사한다. 현재는 **동일 acquisition과 동일 geometry**가 범위 일치의 유일한 근거다. 같은 입력의 Raw·후처리 결과는 이 조건에서 비교할 수 있다. 다른 환자/추적 검사에서 해부학적 범위가 같다는 정보는 기존 결과에 없으므로 일치한다고 만들지 않는다.

호환성이 없거나 불명확하면 수치 비교 버튼을 막고 이유를 표시한다. 별도의 `나란히 열람`에서는 최대 3개 고유 결과의 값·단위·variant·QC·3D를 표시하되 동일 조건의 비교임을 보증하지 않는다고 표시한다. 케이스 간 차이율/순위/통계는 계산하지 않는다. 기존 로컬 비교 화면의 정책과 수치 계산은 변경하지 않았다.

과거 model/recipe/package digest는 미기록 상태를 유지하고 화면에 표시한다. MRI Water에서 측정되지 않은 지방침윤율을 생성하지 않는다.

## 데이터·권한 경계

| 영역 | 구현 |
| --- | --- |
| 홈 상태·진입 | `desktop/ui/main.tsx`, `solution-readiness.ts`, 기존 계정/설치 dialog |
| 서버 목록·선택·복귀 | `desktop/ui/remote-results.tsx`, `account-state.ts` |
| 읽기 전용 측정·QC·3D | 기존 `result-view.tsx`의 remote 경계, `remote-contract.ts` |
| Main 전용 API/3D stream | `desktop/remote-results.cjs`, main atlas protocol, 좁은 preload IPC |
| 가명 연결 | `desktop/publication-context.cjs`, 기존 outbox의 후속 context 연결 |
| 서버 읽기·context·3D | 기존 `results-server.cjs`, `result-verifier.cjs` |

1. Desktop renderer에는 계정 토큰, 임의 서버 URL, 파일 경로, Mask, 복호화 키를 전달하지 않는다. IPC는 실제 main frame만 허용한다.
2. 서버 목록/결과/3D part는 현재 사용자 membership, 기관/workspace, 승인 PC 서명, 장비 보안 상태를 모두 검사한다. 분석 상품의 만료와 과거 데이터 열람 권한은 분리한다.
3. 별도 verifier가 암호화 GLB를 복호화·해시 검증하고 외부 URI/texture/임의 메타데이터 없는 표시용 형식을 검사한 후 `objects/<attempt>/display.glb`를 만든다. **이 사본은 평문 표시 자산**이다. 서버 암호화 볼륨·OS ACL로 보호하고 API 계정에는 필요한 읽기 권한만 부여한다. API는 native Mask 개인키를 받지 않는다.
4. 공개된 결과의 현재 attachment revision과 GLB hash가 일치할 때만 1 MiB 단위의 표시 바이트를 제공한다. Staging, 삭제 결과, 타 기관, Mask artifact는 이 경로에서 제공하지 않는다.
5. 앱 main은 계정·대상에 묶인 임시 URL을 만들고 바이트 수·최종 SHA-256을 검사하며 renderer에 stream한다. `Cache-Control: no-store`, 디스크 저장 없음. 화면 종료·계정 변경 시 핸들을 지우고 중간 응답도 재검사한다. 기존 Scene이 메모리/GPU 자원을 dispose한다.
6. 삭제/만료 정리 시 표시 사본도 해당 attempt 디렉터리와 함께 정리한다. 백업에 남은 자료의 물리적 폐기는 기존 보존 정책을 따른다.

## 서버 업데이트·되돌리기

서버 → Desktop 순서로 업데이트한다. 새 `context`, `mesh-part` API가 없는 구버전 서버에 새 Desktop을 먼저 붙이지 않는다. HTTPS/IdP/proxy 설정은 [P5 구성](EXMO_SOLUTION_P5_IMPLEMENTATION.md)의 같은 origin을 사용한다. 브라우저 직접 접근을 허용하지 않으며 Web BFF는 P7 범위다.

- Result API와 verifier를 정지하고 DB+objects를 일관된 시점에 백업한다. private key는 별도 보관한다.
- 새 서버는 기존 publications 컬럼을 변경하지 않고 `publication_contexts` 테이블을 추가한다. 기존 contentDigest/identity/tombstone/암호문은 유지한다. 과거 승인 GLB의 display 사본은 verifier가 재검증해 준비한다. 모델을 실행하지 않는다.
- 이전 Desktop의 기본 게시 요청은 그대로 지원한다. 이전 서버 실행파일로 되돌리는 경우 P6 Desktop도 P5로 함께 되돌린다. 추가 context 테이블이 기존 P5 INSERT를 깨뜨리지 않도록 기존 publications 컬럼 수를 보존했다.
- 동기화 중단 후 `공개 결과 + context/3D 후속 처리`가 남을 수 있다. 이미 공개된 측정/Mask를 취소됐다고 표시하거나 삭제하지 않는다. 서버의 동일 결과 ID로 후속 처리를 재시도한다.
- 로컬 가명 매핑은 outbox와 함께 보호 백업 대상으로 포함한다. 복구한 origin은 기존 기관 관리자 승인이 필요하다. 다른 PC에서 Windows 보호 파일을 그대로 읽을 수 있다고 가정하지 않는다. 이미 게시된 context는 서버에서 재사용하며, 미게시 환자 매핑의 PC 간 복구/기관 환자 마스터 통합은 별도 운영 설계가 필요하다.

## 검증과 남은 범위

```text
npm run test:remote
npm run test:publications
npm run test:accounts
npm run test:license
npm test
npm run check
npm run test:language
npm run build:desktop
node node_modules/electron/cli.js scripts/security/validate-publication-desktop.cjs --archived-reader --remote
```

테스트는 합성 IdP/계정 서버와 기존 보호된 QA 결과를 사용한다. CT·MRI·AP·LAT-LT·LAT-RT의 암호화 게시/조회, 실제 CT/MRI 3D, X-ray 방향 순서, 선택과 포커스 복원, 호환성 거부, 로그아웃·재로그인 복귀, 역할 회수 및 로컬 홈 복귀를 실제 Electron에서 검사한다. X-ray Study 연결은 시험 DB의 합성 가명 연결이며, 환자 원본 메타데이터를 변경한 시험이 아니다. 추론을 재실행하거나 전처리·좌표 복원·정밀도·후처리 계산을 바꾸지 않았다.

실행 증거는 `outputs/publication-desktop-check/<run>/remote-verification.json`, `verification.json`, `remote-*.png`에 남긴다. `passed:true`인 실행만 완료 증거다. Source/isolated package 확인과 실제 고객 설치본·운영 서버 검증을 구분한다.

이번 통과 기록:

- Remote 6개 테스트: 실제 OIDC/PC 서명 조회·권한 회수, 가명 매핑 보호·지속성, 비교 계약, 홈 상태별 진입, 중간 계정 변경/손상 stream 거부, IPC 경계. 재조회는 변경 없는 mesh URL을 유지한다.
- Publication 8개, Account 6개, License 24개 및 분석 파이프라인/조기 결과·3D 실패/상호작용 회귀 통과. 추가 테이블 적용 후 outbox/백업 복원 시험도 재확인했다.
- 최종 Electron 증거: `outputs/publication-desktop-check/c648c600-5bea-49e0-a4b8-719cbb457f66/`. CT/MRI 각 뷰의 독립 회전을 실제 입력·화면 픽셀 변화로 확인했다. X-ray AP-only/누락 view, 삭제 반영, 900px 창도 통과했다.
- `work/p6-package-check/win-unpacked` 격리 패키지: 새 main 모듈 포함, 서버 코드/개인키 제외, 서명된 공용 runtime·ASAR 무결성 정책 확인. `release/internal`과 기존 설치본은 교체하지 않았다. 코드 서명된 고객 설치 프로그램 검증이 아니다.

후속으로 [대표 Overlay 승인·게시·열람](EXMO_REPRESENTATIVE_OVERLAY_IMPLEMENTATION.md)을 구현했다. 이미지 게시 이후의 서버 rollback 주의점도 해당 문서를 따른다.

남은 작업: Web/태블릿 Viewer·BFF(P7), 실제 IdP/HTTPS/서비스 계정 ACL/암호화 볼륨·운영 복구, 실물 동글·새 PC·코드 서명 고객 설치본(P8). 이 단계로 전체 제품 출시 acceptance가 끝난 것은 아니다.

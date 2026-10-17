# P1 — 솔루션 등록·로컬 결과 식별 구현 기록

작업일: 2026-10-17. 작업 브랜치: `feat/solution-productization`. 복귀 기준: `f790036` (설계·모형 포함), 기존 제품 코드 기준: `d474eea` / `feat/desktop-security`. 제품 전체 계획은 [구현·검증 계획](EXMO_SOLUTION_PRODUCTIZATION_PLAN.md)을 따른다.

## 구현한 범위

홈의 CT/MRI/X-ray 고정 배열을 main 프로세스의 `desktop/solutions.cjs` 조회로 바꿨다. 기존 clinical table과 분석 화면은 유지했다. 상태 조회가 한 솔루션에서 실패해도 다른 솔루션의 결과는 표시하고 해당 행에 오류를 보여준다.

| solutionId | workflowId | 기존 analysis / 실제 route | 필요한 현재 runtime |
| --- | --- | --- | --- |
| `exmo.thigh.ct` | `thigh-ct-v1` | `ct` | ct |
| `exmo.thigh.mri` | `thigh-mri-water-v1` | `mri` | ct, mri |
| `exmo.lower-extremity.xray` | `lower-extremity-projection-v1` | `xray`: AP, LAT_LT, LAT_RT | ct, ap, lat |

현재 공용 reader와 X-ray classifier의 의존성도 위 runtime에 포함된다. 이 목록은 설치 상태 확인을 위한 기존 의존성이다. 선택 설치나 개별 상품의 새 권한을 구현한 목록이 아니다.

P1은 modality당 기존 workflow 하나만 등록하도록 검사한다. 미래 CT 상품 fixture는 **미등록 ID의 우회 차단** 검사다. 같은 modality에 두 번째 실행 상품을 등록하려면 P2에서 dispatcher와 main/Python 권한 계약을 solution 단위로 함께 확장해야 한다. 목록 한 줄만 추가해서 기존 CT 실행 허가를 공유할 수 없게 했다.

화면에서 선택한 solutionId가 파일 선택·입력 미리보기·분석 시작·결과 조회·환자 지정·내보내기 요청에 전달된다. main에서 등록된 ID를 기존 분석 경로로 해석한다. 기존 `ct/mri/xray` 호출도 호환된다. 명시된 ID가 알 수 없거나 analysis/workflow/schema와 충돌하면 legacy alias로 우회하지 않는다. 다른 CT 상품의 입력·결과는 CT thigh 목록/실행/미리보기/내보내기/환자 지정에 섞이지 않는다. 공유 입력 폴더는 다른 입력이 참조하면 목록 비우기에서 지우지 않는다.

Python runner, 전처리, 추론 설정, precision, 좌표 복원, 후처리, 좌우 계산, 모델 가중치는 변경하지 않았다. 실행 허가는 기존 main/Python 경로를 그대로 사용한다. AP-only/LAT-only와 classifier 권한도 기존 규칙이다. registry 조회나 파일 설치 상태가 실행 권한을 부여하지 않는다.

## 결과 ID와 저장 경계

`desktop/result-identities.cjs`가 다음 정보를 추가한다.

- `solutionId`, `workflowId`, `resultSchema: exmo.analysis-result.v1`
- `originStoreId`: 원래 결과 저장소의 ID. 보호된 설치에서는 기존 결과 키 저장소 ID와 결합한다.
- `originResultId`: 한 번의 분석 결과를 식별한다. Raw/PP500/강화 후보가 같은 값을 공유한다.
- `analysisRevision`: variant, native Mask/좌우 Mask, 측정/QC·geometry에 대응하는 스냅샷 ID. 같은 Raw로 복귀하면 이전 ID를 재사용한다.
- `provenance`: 현재 adapter와 legacy 결과 여부. 과거 모델/recipe digest를 알 수 없는데 임의로 만들어 넣지 않는다.

기존 `published.json`, Mask, 측정 파일을 읽기 migration으로 덮어쓰지 않는다. `imaging/result-origin.json`과 `imaging/runs/<id>/identity.json`에 별도 기록한다. 신규 publication에는 위 메타데이터도 저장한다. 지연된 3D, mesh 오류/재시도, 표시 색상, 환자 정보 지정, 처리 시간은 analysisRevision을 바꾸지 않는다.

Mask는 추가 복호화하거나 renderer로 보내지 않는다. 식별용 파일 fingerprint는 비동기 stream으로 읽고 동일 메모리 publication에 대해 재사용하므로 결과 polling마다 파일 전체를 읽지 않는다. 이 fingerprint는 **로컬 변경 식별용**이다. 향후 P5의 정규화된 원문 `contentDigest`, 임상 신뢰성 검증 또는 변조 방지 검증이 아니다. 전송용 재암호화는 이 ID를 그대로 가져가야 한다. 로컬 파일 자체를 다시 암호화·인코딩하는 migration은 아직 구현하지 않았으며, 적용한다면 기존 ID를 보존하는 별도 절차가 필요하다.

손상된 식별 파일을 자동으로 새 ID로 교체하지 않는다. 공간/권한/손상 오류는 케이스별 진단으로 표시하고, 기존 측정·Overlay 열람은 유지한다. 다른 케이스는 정상적으로 열린다. 이 오류가 있는 결과의 서버 게시 허용 여부는 P5에서 반드시 거부하도록 연결해야 한다.

**백업·복구에는 결과 폴더뿐 아니라 위 sidecar와 기존 결과 보안/복구 파일도 함께 보존해야 한다.** 식별 파일을 삭제해서 재생성하는 방식은 복구 절차가 아니다. 다른 저장소의 origin marker와 섞지 않는다. 서버 재게시·계정 변경 시 ID 유지의 실제 서버 검증은 P5에서 진행한다.

## 검증한 내용

| 검사 | 결과 / 한계 |
| --- | --- |
| `npm run test:solutions` | 기존 5 route 매핑, 알 수 없는 동일-modality 상품 격리, 반복 migration, Raw 복귀, 동시 variant 기록, 지연 mesh, 같은 측정값의 다른 Mask, 저장소 복사/복구, 손상 시 읽기 유지 통과. 합성 fixture |
| `validate-solution-results-desktop.cjs` | 저장된 실제 CT/MRI/AP/LAT-LT/LAT-RT 5건을 격리 사본에서 real Electron/preload/IPC/worker로 열람. 측정값 동일, native 미리보기 9개, CT/MRI GLB 응답, 원본 20개 파일과 사본 publication 불변 확인. 새 추론 실행 아님 |
| `validate-results-workflow.cjs` | 한 솔루션 상태 오류가 나도 다른 결과 표시, 결과 선택/Excel/최대 3개 비교/선택 유지 통과 |
| `validate-review-selection.cjs`, `validate-patient-workflow.cjs` | 입력·검토 선택, 정확한 solution ID/입력 IDs, 환자/촬영일 묶음·검색·지정 통과 |
| `validate-error-ui.cjs` | 케이스별 Overlay/3D 오류, 정상 비교 화면 유지, 재시도 통과 |
| `validate-xray-studies.cjs`, `validate-xray-studies-desktop.cjs` | Lt/AP/Rt 순서, 빠진 view 7조합, 중복 view, 결과 그룹 재열람 통과. Desktop fixture의 GPU 캡처는 `UnknownVizError`로 중단되어 `EXMO_TEST_SOFTWARE_RENDERING=1`로 다시 실행해 통과 |
| `npm run test:license` | 기존 라이선스 24개, 조기 결과 공개/취소/권한 회수/대기열 검사 통과. 실제 YubiKey 시험 아님 |
| `npm run test:model-security` | 모델·복구·payload 8개 검사 통과. 결과 저장소 ID는 키 복구 전후 동일함도 별도 확인 |
| `npm run check`, `npm run test:language`, `npm test` | 타입·언어 키·기존 atlas/상호작용 검사 통과 |
| `npm run build`, `npm run build:desktop` | Web/Desktop 빌드 통과. 기존 큰 JS chunk 경고는 남음 |
| 추가 확인: `validate-review-render.cjs` | `Unexpected module ./diagnostics`로 실패. `f790036`의 원래 컴포넌트에서도 같은 오류를 재현했다. 오래된 정적 mock의 의존성 누락이며 이번 변경에서 수정하지 않았다. 현재 입력·검토 동작은 위 real Electron UI 검사로 확인 |

실제 데이터 검증 기록/홈 캡처: 로컬 `outputs/solution-productization-check/saved-results.json`, `home.png`. 원본 파일 경로·hash가 포함된 기록은 Git에 올리지 않는다. 기준 commit, 기존 ASAR/엔진 인덱스의 hash는 같은 폴더의 `baseline.json`에 기록한다. 기존 ASAR는 새 소스 빌드와 같다는 뜻이 아니며 이번 작업에서 재패키징하지 않았다.

검사 중 실패한 실행의 임시 `userdata-*` 폴더는 후속 삭제 명령이 자동 승인 검토에서 정책상 차단되어 남아 있다. 완료된 마지막 실행의 영상 사본은 검사 스크립트에서 제거했다. 모두 Git 제외 경로다.

재실행:

```powershell
npm run test:solutions
npm run build:desktop
$env:ELECTRON_RUN_AS_NODE = $null
node node_modules/electron/cli.js scripts/validate-solution-results-desktop.cjs
```

실제 결과 fixture 경로를 바꾸려면 `EXMO_SOLUTION_RESULT_SOURCE`에 `runs`가 있는 imaging 저장소를 지정한다. 원본 대신 검사 사본에 ID 파일을 만든다. 보호된 암호화 fixture를 이 개발 모드 reader에 넣는 검사는 별도 키 초기화가 필요하므로 이 스크립트의 지원 대상이 아니다.

## 다음 단계와 복귀

다음은 **P2: 솔루션별 권한·발급**이다. v3 entitlement/recipe/model 결합, main과 Python의 동일 검사, 새 Mask를 만드는 후처리 권한과 확정 Mask를 표시하는 reader 권한을 분리한다. 현재 P1의 목록 분리는 상품 라이선스 v3가 아니다.

선택 설치, OIDC 로그인, 기관 서버 업로드, 원격 viewer, 서버 배포, 고객 설치본·실물 YubiKey·다른 PC 검증은 이번 완료 범위에 포함하지 않는다. 신규 CT/MRI/X-ray 전체 추론을 다시 돌리지 않았다.

기존 동작 확인용으로 `git worktree add --detach ../AtlasViewer-before-solutions f790036`을 사용할 수 있다. 이전 버전은 추가 메타데이터를 무시한다. 신규 파일을 제거하거나 원본/Mask를 변환하는 rollback은 필요 없다. 복귀 후 이전 앱에서 만든 새 결과에는 새 앱을 열 때 ID가 부여된다.

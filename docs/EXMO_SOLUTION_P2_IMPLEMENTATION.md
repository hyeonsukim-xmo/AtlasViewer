# P2 — 솔루션별 실행 권한 구현 기록

기준: 2026-10-18, `feat/solution-productization`, P1 `db5271d` 이후 변경. 이 문서는 구현된 소프트웨어 경계와 실제 검증 범위를 기록한다. 운영 서버 배포, 신규 설치본 배포, 실물 YubiKey 검증 완료 기록은 아니다.

## 구현 범위

| 경계 | 구현 |
| --- | --- |
| 서버 계약 | 별도 `exmo-license-v3` / `exmo-desktop-v3`, `/v3/challenges`, `/v3/leases`. v2의 strict parser와 `/v1` 호환 경로 유지 |
| 상품 권한 | 기관 ID, 상품별 시작/종료 시각·회수/정지·revision, `analyze` / `classify` / `result-mutation` capability |
| 실행 조합 | solutionId, workflowId, capability, 정확한 engine, modelDigest, recipeDigest, packageSetDigest 모두 일치해야 허용 |
| main / Python | main의 승인 후 Python이 같은 조합·실제 설치 recipe·worker nonce·job hash·PC 서명을 다시 확인. customer는 동글 서명도 필요 |
| 새 후처리 | 별도 `exmo-result-mutation-v1`. 모델 복호화 키 없이 원본 origin/revision, Mask/sideMask, snapshot, 요청 variant에 결합 |
| 진행 중 분석 | 승인된 추론의 완료 증명을 결과 보호 키로 인증. 해당 run·입력·route·출력 digest에 한정해 최초 Raw 측정/좌우 확정을 완료. 이후 회수로 중간 결과를 버리지 않음 |
| 확정 결과 | variant별 immutable snapshot. 기존 variant 복귀는 읽기. 동일 Mask의 표시 mesh 생성/재시도는 신규 상품 권한·모델 키 없이 가능 |
| 관리 | customer/internal 공통 관리 함수, 원장 transaction, dry-run·원장 사본, 상품별 회수/기간 변경, 실제 설치 파일의 execution binding 추출 |
| 호환 | build/worker에 `licenseVersion` 고정. v3 장비의 로컬 downgrade 거부. 서버 전환 후 v2 allow 재발급 금지 |

기존 3개 built-in workflow만 실행한다. 임의 catalog로 코드를 로드하거나 다른 CT 상품을 만들지 않는다. 동일 modality에 두 번째 workflow를 실제 추가하려면 dispatcher도 분리해야 하며, registry guard를 단순 삭제해서는 안 된다.

## 정확한 버전 결합

- `modelDigest`: 기존 서명된 암호화 모델 package token의 SHA-256. vendor 코드·설정·가중치의 기존 검증은 유지한다.
- `recipeDigest`: capability/engine/variant 및 **실제로 배포된 imaging 폴더의 Python 파일 바이트 hash 목록**으로 계산한다. JS와 Python이 독립적으로 같은 값을 만든다.
- `packageSetDigest`: 서명된 `engine/payload.json` token의 SHA-256. 이 서명은 runtime inventory에 결합된다. 기존 main의 전체 payload 검증을 생략하지 않는다.
- v3는 내부 설치도 signed payload가 필요하다. 내부라는 이유로 상품 제한을 생략하지 않는다.
- source tree와 frozen installer의 Python 바이트는 다르므로, 설치본 권한을 source tree hash로 발급하면 거부되는 것이 정상이다. 설치 후보의 `resources/imaging`과 그 후보의 `resources/engine`을 사용한다.
- 현재 P2는 runtime 전체 payload를 하나의 packageSet으로 고정한다. 선택 설치별 dependency closure는 P3이며, 여기서 권한 검사를 느슨하게 해서 대체하지 않는다.

v3 최대 token은 128 KiB, 상품은 64개, execution 조합은 전체 256개다. 모두 동시에 최대 크기까지 발급된다는 뜻은 아니다. 직렬화된 token 크기를 넘으면 발급 transaction을 거부한다. v2의 기존 크기/엔진 제한은 그대로다.

## 결과 읽기와 새 계산

`desktop-snapshot-{variant}.json`에는 확정된 publication, Mask/sideMask의 **저장 바이트 digest**, 표시 mesh recipe가 담긴다. 보호 설치에서는 결과 저장 키로 HMAC 인증한다. 개발 source 모드의 checksum은 보안 인증을 대신하지 않는다.

- 초기 확정에는 모델 worker가 남긴 `desktop-completion-auth.json`이 필요하다. 입력·run·native Mask/관련 측정 파일이 다르면 거부한다. 성공한 추론의 정해진 Raw 결과만 확정할 수 있다.
- 완료 증명은 한 번의 최초 확정에만 사용한다. 확정이 실패해 snapshot이 없는 run은 완성된 결과로 표시하지 않는다. 현재 복구 경로는 새 분석이다. 중단 run의 재개 UX는 별도 작업이다.
- 새로운 후처리는 main에서 source snapshot과 origin/revision을 결합하고, worker가 원본 snapshot과 identity sidecar를 재확인한다. nonce 재사용, 다른 revision/Mask/recipe, 임의 request 변경을 거부한다.
- 기존 variant로 돌아갈 때는 snapshot을 읽는다. Raw/PP500/강화 값과 Mask를 다시 계산하지 않는다. 이전 버전이 이미 저장한 `published.json` 또는 `desktop-result-{variant}.json`도 계산 없이 snapshot으로 채택할 수 있다.
- legacy 채택은 기존 로컬 결과를 보존하는 호환 절차다. 과거 생성 시점의 암호학적 출처를 소급 증명하는 기능은 아니다. 보호되지 않은 개발 snapshot을 고객 저장소로 무작정 복사해서 신뢰하도록 만들지 않는다.
- mesh 요청은 해당 snapshot의 Mask/sideMask, 구조·측정·좌우 정보와 일치해야 한다. 주입된 다른 Mask 경로나 측정값을 새 계산으로 처리하지 않는다. palette/name 같은 표시 정보 변경은 수치 변경과 구분한다.
- 저장된 결과의 모델이 없어도 reader는 동작한다. **CT 기반 공용 reader runtime 자체를 제거해도 된다는 뜻은 아니다.** runtime 분리는 P3다.
- 표시 mesh 함수가 변경되면 기존 snapshot과의 recipe 불일치는 거부한다. 과거 표시 recipe/runtime을 보존하는 업그레이드 정책도 P3에서 다룬다.

추가 파일은 기존 결과 폴더 안의 sidecar다. 원본 영상과 기존 Mask를 재저장하거나 수치를 수정하지 않는다. 초기 추론·전처리·좌표 복원·정밀도·모델 설정은 변경하지 않았다. `model-runner.py`의 변경은 계산 종료 후 완료 증명 기록뿐이다.

## 서버 준비와 발급 순서

실제 서버는 아직 배포하지 않았다. 아래 명령은 **EXMO 발급 서버/관리 환경**에서 수행한다. 개인키·authority 원장은 고객에게 전달하지 않는다. 기존 customer attestation 및 model envelope 발급 절차를 먼저 따른다.

1. `server-ops.cjs backup`으로 개인키·모델 키까지 포함한 전체 권한 서버 백업을 보관한다.
2. 기존 `approve`, `grant-model`로 PC/동글과 모델 envelope를 승인한다. 신규 v3 장비는 v2로 먼저 활성화하지 않는다.
3. 설치 후보에서 execution 목록을 추출한다.

```powershell
node scripts/security/solution-admin.cjs executions AUTHORITY_DIR ENGINE_DIR IMAGING_DIR executions.json
```

4. 아래 형태의 assignment JSON을 만든다. `executions`에는 추출 결과에서 해당 상품/허용 route의 객체를 **그대로** 넣는다. hash를 추측하거나 placeholder를 그대로 발급하지 않는다.

```json
{
  "orgId": "hospital-example",
  "entitlements": [
    {
      "entitlementId": "ct-thigh-contract-001",
      "solutionId": "exmo.thigh.ct",
      "validFrom": 0,
      "validUntil": null,
      "state": "active",
      "revision": 1,
      "capabilities": ["analyze", "result-mutation"],
      "executions": []
    }
  ]
}
```

위의 빈 executions는 실행을 허용하지 않는 형식 예시다. CT/MRI에는 원하는 후처리 variant의 binding도 넣는다. X-ray AP-only 계약은 AP 및 필요한 classifier binding만 포함하고 LAT_LT/LAT_RT로 자동 확대하지 않는다. classifier 허용과 segmentation 허용은 각각 검사한다.

5. dry-run의 `readyAt`과 권한 목록을 확인하고 적용한다.

```powershell
node scripts/security/solution-admin.cjs solutions-dry-run AUTHORITY_DIR LICENSE_ID assignment.json
node scripts/security/solution-admin.cjs solutions AUTHORITY_DIR LICENSE_ID assignment.json
node scripts/security/solution-admin.cjs solution-status AUTHORITY_DIR LICENSE_ID exmo.thigh.mri revoked
node scripts/security/solution-admin.cjs solution-expiry AUTHORITY_DIR LICENSE_ID exmo.thigh.mri 2027-10-18T00:00:00Z
```

`solutions`는 원장 사본을 먼저 남긴다. 이는 전체 서버/개인키 백업을 대체하지 않는다. `customer-admin.cjs` / `internal-admin.cjs`에서도 동일한 solutions·solution-status·solution-expiry 명령을 사용할 수 있다. 전체 document를 수정하면 변경한 entitlement의 revision도 올려야 한다. 상태/기간 CLI는 이를 transaction 안에서 처리한다. 계약의 장비 전체 만료 시각은 상품 만료와 별도로 상한이 된다.

6. v3 build 정책을 발급하고 해당 설치 후보에 고정한다.

```powershell
node scripts/security/internal-admin.cjs build-config-v3 AUTHORITY_DIR https://license.example.com build-v3.json
node scripts/security/customer-admin.cjs build-config-v3 AUTHORITY_DIR https://license.example.com build-v3.json
```

두 명령은 서로 다른 profile의 authority에서 사용한다. 내부 loopback 시험만 기존 `--loopback-test`를 허용한다. 기존 `build-config`는 v2 호환용으로 남아 있다. installer 생성/고객 코드 서명 gate는 우회하지 않는다.

### 이미 운영 중인 v2 장비의 전환

- 변환한 계약의 v2 endpoint는 새 allow를 발급하지 않고 서명된 revoked를 반환한다.
- 이미 발급된 오프라인 lease를 서버에서 즉시 없앨 수는 없다. 기록된 마지막 v2 만료까지 기다린 뒤 v3 활성화를 허용한다. 과거 발급 만료 기록이 없는 원장은 변환 시점부터 기존 grace 기간을 보수적으로 기다린다. 현재 상한은 7일이다.
- `readyAt`은 epoch seconds이며, 그 전에 v3 활성화를 하면 권한 발급이 거부된다. 신규 장비는 v2 lease 발급 이력이 없으므로 이 대기가 없다.
- 서버의 v3 전환은 구 client가 상품 부분 회수를 우회하는 재발급 경로를 막는다. 장비의 시계/전체 디스크 snapshot rollback을 완전히 방지한다는 뜻은 아니다.
- code rollback 기준은 `db5271d`다. **운영 원장을 v3로 전환한 뒤 구 앱으로 돌아가는 것은 별개**다. v2 재발급을 열어서 회수된 권한을 되살리지 않는다. 원장 사본은 검토/복구 자료이며, 온라인 원장을 무작정 과거 상태로 덮어쓰면 안 된다.

## 확인한 범위

| 검사 | 결과 / 한계 |
| --- | --- |
| `test:solution-security` | strict claim/execution 33개 shared JS/Python 판정, v2 drain, 상품별 회수·만료·offline/restart, 실제 Python의 암호화 fixture 모델 로딩/거부 |
| 신규 후처리 guard | 별도 PC 서명, nonce replay/recipe 변조/source Mask 변조 거부, 원본 revision 결합, 회수 후 신규 mutation 거부 |
| 결과 reader | 회수 후 기존 측정 조회·mesh 생성, worker 재시작 및 모델 경로 없음에서도 읽기/mesh 가능, 측정 주입과 Mask 변경 거부 |
| 기존 라이선스 | 24개 테스트 통과. 대기 case는 회수 후 거부, 이미 실행 중인 GPU/CPU case 완료와 early result/late mesh 회귀 포함 |
| 기존 모델 보안 | 9개 테스트 통과. CNG, customer v2/v3 이중 봉투와 별도 mutation 서명, 모의 hardware proof, 복구, payload·backup. 실물 YubiKey 시험은 아님 |
| 암호화 결과 합성 입력 | CT/MRI/AP/LAT_LT/LAT_RT 완료 증명·측정·Overlay 및 CT/MRI deferred 3D 통과. 실제 segmentation 추론 대신 합성 native Mask 사용 |
| 실제 저장 결과 Desktop | 기존 5개 route 측정값 그대로, 9개 native Preview, CT/MRI GLB, registry/preload/IPC 통과. 원본 파일 불변. 신규 추론 아님 |
| build / 정적 검사 | TypeScript, 언어 parity, solution identity/격리, Desktop build, diff 검사 |

주요 재현 명령:

```powershell
npm run test:solution-security
npm run test:license
npm run test:model-security
npm run test:artifact-security
npm run test:solutions
npm run check
npm run test:language
npm run build:desktop
$env:ELECTRON_RUN_AS_NODE = $null
node node_modules/electron/cli.js scripts/validate-solution-results-desktop.cjs
```

실제 저장 결과 증거는 git 제외 `outputs/solution-productization-check/saved-results.json`에 있다. private 경로와 원본 데이터는 commit하지 않는다.

## 남은 단계

- 실물 **YubiKey 5C NFC / firmware 5.8**: 사용자 도착 예정 약 5일 뒤. 실제 attestation, PC 귀속, 오프라인 새 작업 증명, 동글 제거 중 진행 작업 완료, 다른 PC 거부, 재연결/분실 대응을 검증한다. 이번 fixture 결과로 실물 통과를 주장하지 않는다.
- 신규 v3 서명 설치본, 실제 HTTPS authority/운영 DB, 다른 PC의 end-to-end 추론은 미검증. 운영 DB를 PostgreSQL로 바꾸거나 원격 배포하지 않았다. 기존 SQLite 발급 서버에 transactional P2 계약을 구현한 상태다.
- P3 선택 설치·공용 reader runtime 분리·업데이트 복구, P4 로그인, P5 서버 게시, P6 홈 상태 UI, P7 Web/태블릿은 이번 변경에 포함하지 않는다.
- 기존 `validate-review-render.cjs`의 obsolete static fixture 오류는 P1 기록에 남긴 기존 문제이며, 이번 권한 변경으로 수정하지 않았다.

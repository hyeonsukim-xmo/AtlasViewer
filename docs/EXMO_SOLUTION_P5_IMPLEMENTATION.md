# P5 결과 게시 구현·검증 기록

기준: 2026-10-18, `feat/solution-productization`. 결과 게시의 로컬 구현과 시험 서버 검증 기록이다. 실제 기관 서버·IdP 배포, 코드 서명된 고객 설치본·실물 YubiKey 시험, 원격 Web/태블릿 Viewer 완료를 의미하지 않는다.

## 적용 범위

- 결과 화면의 **서버에 게시 → 현재 결과 게시**는 현재 선택한 최대 3개 결과 revision을 전송 큐에 넣는다. 자동 게시하지 않는다.
- 상단 **전송 현황**에서 진행·실패 이유·재시도·취소를 확인한다. 기존 분석/비교 표의 행 선택·폭·3D 조작은 바꾸지 않았다.
- 계정의 현재 기관/workspace, 게시자 subject, 현재 설치 PC를 enqueue 시 고정한다. 다른 계정 또는 workspace로 바뀌면 다음 요청부터 보류한다. 이미 서버에 도달한 commit은 로그아웃으로 되돌릴 수 없으며 서버 삭제와 별도다.
- 기관 `analyst`가 게시한다. `data-admin`은 결과 화면에서 **이 저장소를 현재 기관 소속으로 승인**할 수 있다. EXMO 운영자·장비 관리자 역할만으로 임상 결과에 접근할 수 없다.
- 기존 저장소의 소속을 로그인 계정에서 추측하지 않는다. 기관 데이터 관리자의 명시적 origin 승인이 먼저 필요하다. 복구한 PC도 같은 origin ID를 보존하고 별도로 승인받는다.
- 분석 계약 기간이 만료되어도 저장된 결과의 게시 권한은 별도로 판단한다. 서버의 장비 승인/보안 정지·회수, 기관 membership은 매 요청에서 검사한다. 신규 분석 권한·모델 키는 이 기능에서 발급하지 않는다.

## 전달하는 데이터

| 항목 | 이번 구현 |
| --- | --- |
| 측정값·QC | 고정 snapshot에서 allowlist로 추출. 총량/좌우/CT fat-range/HU/entropy/후처리 변화량 등 기존 값 그대로 |
| Native Mask | 원본 좌표의 정수 label 배열을 little-endian uint16, x가 가장 빠른 순서로 직렬화. geometry는 size/spacing/origin/direction으로 별도 보존. NRRD/NIfTI header·입력 파일은 전송하지 않음 |
| 3D | 해당 snapshot의 표시 GLB만 후속 첨부. 실제 CT/MRI GLB를 검증. 외부 URI·이미지/texture·임의 extras는 거부 |
| 원본 영상/환자명·환자번호/Study UID/로컬 경로 | 전송 manifest와 조회 projection에서 제외 |
| 대표 Overlay | **이번 전송에서는 제외**. 픽셀 식별정보 검토·비가역 제거·최종 hash 승인 UI/API를 구현하기 전에는 전송하지 않음 |
| 확률/entropy/disagreement 전체 배열 | 전송하지 않고 공유를 위해 재추론하지 않음 |

Mask 전송 형식 변경은 저장된 Mask나 모델 출력을 바꾸지 않는다. 서버 검증기는 복호화한 label count·단위·geometry와 전송 측정값을 대조한다. 지방량·entropy·좌우 계산을 서버에서 새로 수행하거나 임상 정확도를 판정하는 검증이 아니다. 원본은 로컬에 유지되므로 이 전송만으로 서버에서 임의 slice의 원본 Overlay를 생성할 수 없다.

기존 snapshot은 모델/recipe/package digest를 완전하게 보존하지 않았다. 그런 provenance는 **null(미기록)**로 게시하며 현재 설치된 모델의 digest로 채우지 않는다. 원래 모델 실행 기록을 확장하는 작업은 별도 변경으로 남긴다.

## 구현 지도

| 경계 | 파일 |
| --- | --- |
| 불변 content/manifest, 필드·크기 검증, canonical SHA-256 | `desktop/publication-protocol.cjs` |
| 확정 snapshot/원본 결과 식별자/기존 GLB 연결 | `desktop/imaging.cjs` |
| 보호된 기존 Mask 읽기·식별 메타데이터 제거·암호화 | `desktop/publication-worker.py`, `desktop/publication_export.py` |
| GLB 암호화/검증기용 bounded 복호화 | `desktop/publication-crypto.cjs` |
| Windows 보호 outbox/재개/재시도/계정 격리 | `desktop/sync.cjs` |
| 좁은 IPC 및 임상 화면과 같은 스타일의 dialog | `desktop/sync-ui.cjs`, `desktop/ui/publication.tsx`, preload/types/main |
| 서버 계정 토큰 사용, PC 서명 | 기존 `account.cjs`, `runtime.cjs`의 main 전용 메서드 |
| 수신·권한/PC proof/origin·transaction·tombstone·감사 | `scripts/security/results-server.cjs` |
| 별도 Mask 복호화 권한, 원문 검증·서명 receipt | `scripts/security/result-verifier.cjs` |

기존 Reader archive에 새 operation을 주입하지 않는다. Snapshot은 기존 Reader로 확인하고, 새 앱에 포함되어 무결성을 검사한 export helper가 서명된 Reader 환경의 의존성을 사용한다. `runtime_bootstrap.py`에는 같은 디렉터리의 고정 `publication-worker.py`만 추가 허용했다. 모델 추론 함수/전처리/정밀도/좌표 복원/후처리 계산은 변경하지 않았다. Export worker의 stdout(키 봉투 등)은 로그에 기록하지 않는다.

## 전송·저장·권한

- 의미상 identity는 `(orgId, originStoreId, originResultId, analysisRevision)`이다. Workspace는 첫 commit 때 고정되며 identity에 넣어 중복·삭제 방지를 우회하지 않는다.
- `contentDigest`는 고정 geometry·측정/QC·Mask 원문 hash·solution/workflow·variant의 canonical JSON SHA-256이다. 재암호화 nonce, uploader, 전송 시각, mesh 상태는 제외한다.
- Artifact마다 새로운 256-bit DEK를 발급하고, 1 MiB part마다 임의 96-bit nonce의 AES-256-GCM으로 암호화한다. RSA-3072/OAEP-SHA256으로 DEK를 감싼다. AAD는 protocol/org/workspace/origin/revision/attempt/kind/part index를 결합한다. 로컬 결과 저장소 키를 서버로 보내지 않는다.
- Mask와 mesh 수신 키, 검증 receipt 서명키를 분리한다. Result API는 공개키만 읽고 private Mask key에 접근하지 않는다. 별도 OS 계정의 verifier가 복호화·hash·size·label/metric 일치를 확인한 뒤 Ed25519 receipt를 발급한다. API는 receipt와 현재 권한을 다시 확인해야 commit한다.
- 같은 identity/content/workspace의 재시도는 동일 resultId로 수렴한다. 다른 content/target/동일 attempt의 다른 manifest는 409다. 늦은 GLB는 기존 revision에 첨부하며 attachment revision CAS를 적용한다.
- 임시 object는 commit 전에 목록에 보이지 않는다. 업로드가 끊기면 보낸 part를 재사용한다. 완료 응답 유실 시 같은 begin/complete로 확인한다. 사본 손실·attempt 만료는 새 암호화 attempt로 준비한다.
- 재시도는 동시성 1, 지수 backoff+jitter, 최대 8회 후 수동 재시도다. 권한·quota·내용 오류는 자동 반복하지 않는다. 로컬 outbox 사본은 원자적 저장과 Windows 보호 저장소를 사용한다. 훼손된 큐는 원본 결과를 삭제하거나 새 대상으로 재배정하지 않는다.
- 서버는 OIDC JWT와 현재 DB membership에 더해 요청 body/route/org/workspace/subject/nonce/시각에 대한 PC 서명을 확인한다. 승인 PC를 다른 기관의 업로더로 주장할 수 없다. Replay nonce는 일회성이다.
- 삭제는 `data-admin` 권한과 현재 revision이 필요하다. Tombstone과 workspace 귀속을 유지하고 조회를 차단한다. 현재 DB의 clinical content를 제거하고 정리 주기에 암호문/임시 content를 제거한다. 기존 백업/WAL·스토리지 snapshot의 물리적 폐기는 기관 보존 정책으로 관리해야 한다. 서버 삭제는 로컬 결과를 삭제하지 않는다.

현재 크기 제한: Mask 1 GiB, GLB 128 MiB, 고정 content 192 KiB, JSON 요청 2 MiB. 서버 org quota 기본 10 GiB이며 public config의 `quotaBytes`로 지정한다. 목록은 최근 200건이다. 대규모 서비스의 pagination/object storage/KMS/전송 부하 시험은 운영 배포 단계의 작업이다.

## 서버 구성 순서

현재 Desktop public build의 `account.apiUrl`과 같은 HTTPS origin 아래에서 경로를 나눈다. `/v1/me`, `/v1/enrollments...`는 P4 Account API, `/v1/publications/...`는 Result API로 전달한다. 토큰과 PC proof header를 유지하고 body limit을 2 MiB 이상으로 맞춘다. 직접 외부에 loopback Node 포트를 열지 않는다. 서버 키가 들어가는 디렉터리는 Git·Desktop 설치본·진단 bundle에 포함하지 않는다.

```text
node scripts/security/result-verifier.cjs init PRIVATE_RESULT_KEYS RESULT_PUBLIC_CONFIG.json
```

생성된 public config에는 아래 `oidc`를 추가한다. P4 Account API와 issuer/audience/clientId가 같아야 한다. Result API에는 이 공개 config만 제공한다.

```json
{
  "maskPublicKey": "<generated RSA public PEM>",
  "meshPublicKey": "<generated RSA public PEM>",
  "receiptPublicKey": "<generated Ed25519 public PEM>",
  "quotaBytes": 10737418240,
  "oidc": {
    "issuer": "https://identity.example.org/",
    "audience": "https://api.example.org/",
    "clientId": "exmo-desktop",
    "jwksUrl": "https://identity.example.org/jwks"
  }
}
```

```text
node scripts/security/results-server.cjs serve RESULT_DIR ACCOUNT_AUTHORITY_DIR RESULT_PUBLIC_CONFIG.json 43129
node scripts/security/result-verifier.cjs watch RESULT_DIR PRIVATE_RESULT_KEYS
```

- Account API가 issuer를 고정하고 장비 승인·membership을 설정한 뒤 실행한다. Node 런타임은 기존 repository의 버전 조건을 따른다.
- Result API의 DB 연결은 account `authority.sqlite`에 대해 read-only다. OS 권한도 DB/WAL/SHM 읽기만 허용하고 issuer private key·model key 파일은 읽지 못하게 설정한다.
- Verifier는 별도 서비스 계정으로 실행하고 private result keys를 그 계정에만 허용한다. API 계정은 result DB/object 저장과 public config만 사용한다. 실제 서비스 ACL/KMS 연결은 운영 서버에서 검증해야 한다.
- HTTPS/proxy에서는 `Authorization`, `X-EXMO-Publication-Proof`, Content-Length를 유지한다. 요청은 buffered JSON이며 chunked request body를 받지 않는다. 브라우저 직접 요청은 거부한다. Web/BFF read 경계는 P7에서 연결한다.
- API 없이 verifier만 켜거나 그 반대로 실행하면 완료되지 않는다. Verifier 장애는 `서버 검증 중` 상태로 유지되며 결과를 완료로 꾸미지 않는다.
- 서비스 자동 재시작, HTTPS 인증서, 모니터링, 계정 DB 접근권, 암호화 볼륨, 보존 정책은 배포 작업이다. 라이선스 발급 키와 result 복호화 키는 다른 백업 정책으로 관리한다.

서버 백업은 API와 verifier를 정지한 일관된 시점에 `results.sqlite`(WAL checkpoint 포함)와 `objects/`를 함께 복제한다. origin 승인·attempt·tombstone도 같은 DB에 있다. Private keys는 접근 통제된 별도 백업에 보관한다. 복원 시 같은 keys/public config/기관 계정 원장을 연결하고 이전 outbox의 중복/삭제 차단을 확인한다. 시험에서는 SQLite snapshot과 encrypted object 복원 후 동일 resultId·측정값·삭제 차단을 확인했다. 운영 DB의 온라인 백업·키 순환은 아직 구현하지 않았다.

## 검증

```text
npm run test:publications
npm run test:accounts
npm run test:license
npm run test:solution-security
npm run test:solutions
npm test
npm run check
npm run test:language
npm run build:desktop
node node_modules/electron/cli.js scripts/security/validate-publication-results.cjs
node node_modules/electron/cli.js scripts/security/validate-publication-desktop.cjs
node node_modules/electron/cli.js scripts/security/validate-publication-desktop.cjs --archived-reader
```

- Publication 8개 시나리오: 실제 OIDC SDK/HTTP + 합성 영상 암호화, multipart, 조회 allowlist, 중복/재암호화, 후속 mesh/CAS, 계정·workspace·role·장비 회수, 위조 PC proof/replay, quota, 위조 receipt/잘못된 count/암호문 변조, 삭제/tombstone, 백업 복구, outbox 재시작/중간 part 재개/취소/완료 응답 유실.
- 기존 Account 6개, License 24개, Solution security 3개 및 registry/분석 pipeline/Overlay 조기 공개·3D 실패 처리/상호작용 회귀 통과.
- 기존 QA 결과 CT·MRI·AP·LAT-LT·LAT-RT 5건을 실제 보호 저장소에서 읽고 암호화 후 원문/label count/geometry/측정값 검증. CT·MRI 실제 GLB도 통과. **재추론하지 않았고 원래 Mask 파일 hash는 변경되지 않았다.**
- 실제 Electron safeStorage·preload·main-frame IPC·renderer에서 기존 MRI → 측정/QC 게시 → GLB 추가를 확인했다. 구버전 archived Reader와 새 app export helper 조합도 통과했다.
- 격리된 `work/p5-package-check`의 Windows ASAR/resources를 검사했다. 새 helper·runtime 무결성 목록 포함, 서버 코드·issuer private key 미포함. 기존 `release/internal`은 교체하지 않았다. 고객 NSIS 서명·설치 검증은 아니다.

로컬 증거: `outputs/publication-check/5f2cc074-8e90-420e-bdfc-0c3a0062c362/verification.json`, `outputs/publication-desktop-check/*/verification.json` 및 `transfers.png`. 실패한 중간 실행 폴더도 있을 수 있으므로 `passed:true` 기록을 확인한다. 테스트 기관/IdP와 실제 운영 기관을 혼동하지 않는다.

## 남은 범위

1. 실제 서버/IdP/HTTPS·OS 서비스 권한·KMS·운영 백업/복구·부하 시험, 실물 YubiKey/새 PC/고객 설치본 검증.
2. 대표 Overlay의 픽셀 식별정보 제거/최종 사본 승인. 이 경로를 만들기 전까지 영상 게시 기능은 제공하지 않는다.
3. 실제 환자/Study 연결·원격 결과 목록/geometry 제공·Web/태블릿 Viewer 및 P6 홈 통합. 지금 원격 조회 API는 측정/QC projection을 반환하며 GLB는 보호 저장까지만 연결했다.
4. 과거 미기록 model/recipe/runtime provenance 보완 정책, key rotation, 대규모 object store와 pagination.

이번 단계는 기본 게시 흐름을 실행 가능하게 만든 범위다. P5의 모든 privacy/운영 acceptance와 P6~P8 완료로 표기하지 않는다.

# Desktop 제품 보안 구현·배포·복구

갱신: 2026-10-16. 이 문서는 현재 코드의 실행 기준이다. 이전 MRI 1차 검증 기록과 제품 출시 승인을 구분한다.

## 구현된 범위

| 경로 | 현재 구현 |
| --- | --- |
| 내부 개발 장비 | 별도 internal 빌드·서명 발급자·저장소. 실제 Windows CNG 설치 서명/RSA 복호화 키, DPAPI 상태 저장. 동글 없이 EXMO의 유한한 승인 필요 |
| 고객 장비 | PC + YubiKey 9E 인증, 9D ECDH 모델 키 해제. attestation 루트 고정, 서로 다른 내부 생성 P-256 키, PIN/Touch Never·펌웨어·기기 형식 확인 |
| 사용권 | 최초 온라인 활성화, 5분 갱신, 서버가 제한한 최대 7일 유예, 계약 기한 우선, 매 신규 실행 새 증명. 회수·만료 시 새 분석만 차단 |
| 모델 | CT, MRI, AP, LAT-LT 5 folds, LAT-RT 5 folds, DICOM/NRRD 방향 분류 자산 각각 AES-256-GCM 암호화·서명 manifest·원본 해시·strict loader |
| 고객 키 봉투 | 안쪽 ECDH-ES+A256KW/A256GCM, 바깥 RSA-OAEP-256/A256GCM. 등록 PC와 동글 모두 필요. 작업 nonce·입력 digest·모델 digest·lease에 다시 결합 |
| 버전 회수 | 모델 manifest digest별 승인/회수. 최신 lease의 허용 목록에 없는 모델은 캐시 재사용도 차단. 오프라인 lease의 남은 유예는 중앙에서 즉시 제거할 수 없음 |
| 결과 파일 | 보호 실행의 runs 아래 NRRD/NIfTI/NPY/NPZ·임시 mask·entropy·side mask·variant를 인증 암호화. 블록별 검증 후 읽기. 평문 mask 임시 파일을 만들지 않는 writer/reader 연결 |
| 결과 복구 | 모델/계약과 독립된 결과 키. DPAPI 보관 + 기관 RSA 복구 봉투 + 새 PC에 귀속된 EXMO 서명 복구 파일. 고객은 복구 봉투 등록 후 신규 분석 가능 |
| 배포 | Python 3.12.8, 4개 분석 환경·PIV 환경, 암호화 모델을 포함한 서명된 오프라인 payload. 고객 NSIS는 payload와 실제 코드 서명 인증서 필수 |
| 실행 파일 | ASAR 무결성·onlyLoadAppFromAsar, RunAsNode/NodeOptions/inspect 비활성화. Python·CNG helper·attestation 인증서 해시 고정. payload 전체 파일 검증 후 실행 |
| 서버 운영 | loopback API + HTTPS reverse proxy 설정 생성, 계약 만료 연장/정지/회수, 감사 원장, 서명된 백업과 검증·복원 CLI |

7일과 5분은 현재 서버 코드의 제한/발급 값이다. 판매 계약 확정과 보안 시계 보장은 별개다. 소스 개발 모드는 기존 엔진을 그대로 실행하며, 이 모드를 고객 설치본으로 배포하지 않는다.

## 모델과 오프라인 런타임 만들기

다음 명령은 EXMO 운영자·빌드 PC에서 실행한다. 경로 토큰은 실제 경로로 바꾼다. 출력은 매번 새로운 폴더를 지정한다. 원본 전달 폴더는 덮어쓰지 않는다.

```powershell
node scripts/security/license-server.cjs init AUTHORITY customer
node scripts/security/model-package.cjs pack-ct AUTHORITY SOURCE_CT PACKAGES/EXMO_CT ct-v1
node scripts/security/model-package.cjs pack-mri AUTHORITY SOURCE_MRI PACKAGES/EXMO_MRI mri-v1
node scripts/security/model-package.cjs pack-xray AUTHORITY SOURCE_XRAY PACKAGES/EXMO_XRAY xray-v1
node scripts/security/payload.cjs create AUTHORITY ENGINE_SOURCE PACKAGES PIV_ENV NEW_PAYLOAD release-v1
node scripts/security/payload.cjs verify AUTHORITY NEW_PAYLOAD
```

`ENGINE_SOURCE`에는 기존 `envs/ct,mri,ap,lat`가 필요하다. `PIV_ENV`는 `scripts/security/requirements.txt`를 설치한 3.12.8 환경이다. 분석 환경 모두 `desktop/requirements-model-security.txt`의 해시 고정 의존성이 있어야 한다. 새 엔진 준비 스크립트는 이를 설치한다. payload 안에는 설치 PC의 Python/venv 절대 경로에 의존하지 않는 base interpreter와 site-packages를 넣는다. 환자 샘플·원본 checkpoint는 제외한다.

이 PC의 생성물:

- 암호화 모델: `work/security-delivery-v2/packages`
- 오프라인 환경: `work/security-delivery-v2/payload`
- 내부 QA 설치 파일: `release/internal/EXMO-Atlas-Internal-Setup-0.1.24.exe`

현재 내부 QA NSIS는 작은 앱 설치 파일이다. 모델/환경까지 한 파일에 포함하려면 아래 마지막 payload 인자로 다시 빌드한다. 현재 생성물은 **내부 발급자용**이며 고객 빌드로 이름만 바꿔 사용할 수 없다.

```powershell
node scripts/security/customer-admin.cjs build-config AUTHORITY https://LICENSE_HOST BUILD_PUBLIC.json
node scripts/security/package.cjs customer dir BUILD_PUBLIC.json NEW_PAYLOAD
# 실제 코드 서명 인증서 설정 후에만 통과한다.
node scripts/security/package.cjs customer nsis BUILD_PUBLIC.json NEW_PAYLOAD

# 승인된 내부 장비용: internal 발급자·build config·payload를 사용한다.
node scripts/security/package.cjs internal nsis INTERNAL_BUILD.json INTERNAL_PAYLOAD
```

`CSC_LINK` / `WIN_CSC_LINK` 또는 `EXMO_SIGNING_CERTIFICATE_SHA1`으로 실제 서명 자격을 제공한다. 비밀번호는 안전한 빌드 환경에서 관리한다. 고객용은 서명 실패를 무시하는 배포 경로가 없다. `customer dir`는 미서명 QA 디렉터리이며 출시 승인으로 취급하지 않는다. 기존 평문 모델 ZIP을 넣는 legacy transfer 명령은 보호 제품 전달 경로가 아니다.

업데이트도 새 서명 payload와 새 설치본으로 배포한다. 실행 중 분석을 종료시키면서 파일을 덮어쓰지 않는다. 이전 설치본·payload를 보관하고 앱을 종료한 상태에서 교체/복구한다. 자동 다운로드·자동 패치·기관 전체 자동 배포는 구현 범위에 넣지 않았다. 이전 모델은 서버에서 승인한 digest와 기존 lease 범위에 한해서만 사용 가능하다.

## 고객 등록과 기능별 모델 승인

실물 초기 프로비저닝은 [YubiKey runbook](EXMO_SECURITY_POC_RUNBOOK.md)을 따른다. 앱의 helper는 등록 키를 읽고 서명/ECDH만 수행한다. 고객 앱에서 키를 초기화하거나 가져오지 않는다.

1. 앱에서 **라이선스 → 등록 요청 저장**. PC의 설치·모델 키와 YubiKey의 attestation을 요청에 묶는다.
2. 운영자가 동글 attestation, 장비·기관·계약을 확인하고 승인한다.
3. 허용하는 각 모델의 봉투를 발급한다. 같은 장비·계약의 새 승인 파일을 적용하면 기존 모델 승인이 유지된다.
4. 기관 결과 복구 정책을 승인 파일에 결합한다. 앱에서 온라인 활성화한다.

```powershell
node scripts/security/customer-admin.cjs approve AUTHORITY REQUEST.json license-001 2027-10-15T00:00:00Z ct,mri,ap,lat
node scripts/security/model-package.cjs grant-model AUTHORITY ct license-001 REQUEST.json PACKAGES/EXMO_CT CT_ACTIVATION.json
node scripts/security/model-package.cjs grant-model AUTHORITY mri license-001 REQUEST.json PACKAGES/EXMO_MRI MRI_ACTIVATION.json
node scripts/security/model-package.cjs grant-model AUTHORITY ap license-001 REQUEST.json PACKAGES/EXMO_XRAY AP_ACTIVATION.json
node scripts/security/model-package.cjs grant-model AUTHORITY lat_lt license-001 REQUEST.json PACKAGES/EXMO_XRAY LT_ACTIVATION.json
node scripts/security/model-package.cjs grant-model AUTHORITY lat_rt license-001 REQUEST.json PACKAGES/EXMO_XRAY RT_ACTIVATION.json
node scripts/security/model-package.cjs grant-model AUTHORITY xray-classifier license-001 REQUEST.json PACKAGES/EXMO_XRAY CLASSIFIER_ACTIVATION.json
node scripts/security/result-recovery.cjs init INSTITUTION_KEYS
node scripts/security/result-recovery.cjs policy AUTHORITY license-001 INSTITUTION_KEYS/recovery-public.pem CT_ACTIVATION.json CT_WITH_RECOVERY.json
```

만료일 대신 `perpetual`을 지정할 수 있으나 주기적 온라인 갱신·유한한 오프라인 lease는 동일하다. 내부 장비는 기존 `internal-admin.cjs` 승인 절차를 사용하며 고객 동글 정책과 섞지 않는다.

```powershell
node scripts/security/customer-admin.cjs extend AUTHORITY license-001 2028-10-15T00:00:00Z
node scripts/security/customer-admin.cjs status AUTHORITY license-001 revoked
node scripts/security/customer-admin.cjs model-status AUTHORITY MODEL_MANIFEST_DIGEST revoked
```

기간 연장은 회수 상태를 해제하지 않는다. PC/동글 이전은 기관 확인 후 이전 설치를 회수하고 새 license ID·등록 키로 새 승인을 발급한다. 이전 PC의 오프라인 유예 중에는 잠시 사용권이 겹칠 수 있다. USB 시리얼 번호만으로 승인하지 않는다.

## 결과 보존과 복구

`result-security/results-key.bin`은 현재 Windows 사용자의 DPAPI로 보호한다. `results-key-id.json`, `result-recovery.json`, `imaging` 데이터 폴더를 기관 백업에 함께 보관한다. 기관의 `recovery-private.pem`은 앱·환자 데이터 백업과 분리해 운영자가 관리한다.

다른 PC에서는 예전 DPAPI blob을 열 수 없다. 기존 결과와 `result-security`를 새 내부/고객 프로필에 복원하고 앱에서 새 PC 등록 요청을 만든다. **읽을 수 있는 결과 키를 새 키로 덮어쓰는 복구는 거부한다.** 기관 운영자가 다음 복구 파일을 만든 후 앱의 **결과 키 복구**로 적용한다.

```powershell
node scripts/security/result-recovery.cjs restore AUTHORITY INSTITUTION_KEYS/recovery-private.pem BACKUP/result-recovery.json NEW_PC_REQUEST.json RESULT_RESTORE.json
```

새 PC의 기관·권한과 백업 출처는 운영자가 확인한다. 복구 후 새 장비의 결과 복구 정책을 다시 등록해야 고객 신규 분석이 가능하다. 결과 열람은 분석 계약·동글 유효성과 분리된다. 원래 입력 영상·허용된 GLB·측정 JSON은 이 mask 암호화 계층의 대상이 아니다. 이전 개발 버전의 평문 결과를 자동 삭제/변환하지 않는다. 결과 키와 기관 복구 키를 모두 잃으면 복구할 수 없다.

## 서버 배포와 장애 복구

```powershell
node scripts/security/server-ops.cjs deploy-files license.example.org NEW_DEPLOYMENT_FILES
node scripts/security/license-server.cjs serve AUTHORITY 43127
node scripts/security/server-ops.cjs backup AUTHORITY NEW_BACKUP
node scripts/security/server-ops.cjs verify NEW_BACKUP TRUSTED_ISSUER_PUBLIC.pem
node scripts/security/server-ops.cjs restore NEW_BACKUP TRUSTED_ISSUER_PUBLIC.pem NEW_AUTHORITY
```

생성하는 Linux systemd/nginx 파일은 실제 호스트·Node 경로·TLS 인증서·운영 계정에 맞춰 설치한다. API는 loopback만 듣고 reverse proxy만 외부 HTTPS를 제공한다. 원격 관리자 API는 없으며 서버 운영 계정과 CLI가 관리자 경계다. 환자 영상·환자번호·mask는 라이선스 요청에 포함되지 않는다.

백업에는 발급 개인키와 모델 DEK가 들어 있다. 보호된 운영자 저장소만 사용한다. Unix mode는 Windows ACL을 대신하지 않는다. 권한 제한·디스크 암호화·별도 보관과 정기 복구 시험은 서버 운영자가 수행한다. 오래된 원장을 복원하면 회수 상태를 잃을 수 있으므로 외부 감사 기록/가장 최근 백업과 대조 전에는 발급 서버를 열지 않는다. 클라이언트는 이미 본 revision/sequence의 역행을 거부하지만 새 PC의 분실된 서버 원장까지 복구해 주지는 않는다.

발급 키 교체는 별도 발급자·새 서명 설치본·모델 패키지·장비 승인으로 계획한다. 키 파일만 교체하면 DB의 발급자 불일치 검사에서 거부된다. 자동 신뢰 키 회전은 제공하지 않는다. 구 발급자를 유지할 기간과 기존 결과 복구 책임을 정한 뒤 이전한다.

## 검증 기록과 재현

```powershell
npm run test:license
npm run test:model-security
npm run test:artifact-security
work/security-poc/env/Scripts/python.exe -B scripts/security/test_yubikey_probe.py
work/security-poc/env/Scripts/python.exe -B scripts/security/test_model_envelope.py
node scripts/security/validate-portable-runtime.cjs work/security-delivery-v2/payload
node scripts/security/check-internal-package.cjs
```

- CT 170개 tensor, AP 150개 tensor, LAT-LT/RT 각각 5 folds의 2,240개 tensor: 실제 원본 loader와 보호 loader의 state hash 일치. X-ray 분류 합성 DICOM/NRRD 예측 일치. `outputs/security-models/a633ad6f-f4c2-4ac3-ab07-28fbce74ecff/verification.json`.
- MRI는 앞 단계의 63개 tensor와 합성 128³ FP32 logits/mask 일치 결과를 재사용했다. 변경하지 않은 환자 추론을 다시 실행하지 않았다. `work/security-mri-validation/8c2b6eea-3f77-4643-9031-568478c70c63/verification.json`.
- 고객 테스트는 HTTPS 검증을 켠 상태에서 이중 JWE·두 종류의 새 증명·Python admission·동글 제거·모델 회수를 검사한다. **합성 동글이며 실물 검증이 아니다.** 운영 attestation 도구가 합성 인증서를 거부하는 것도 검사한다.
- 결과 검증은 합성 CT/MRI/AP/LAT 양쪽의 측정·Overlay와 CT/MRI의 deferred 3D를 실행한다. 파일의 실제 ciphertext, 변조·절단·블록 재배치·다른 키·NRRD/NIfTI/NPY/NPZ readback·기하를 확인한다. MRI 강화 후보·Raw 보존과 실제 vendor Slicer exporter의 전체 metadata/readback도 검사한다.
- portable runtime의 CT/MRI/AP/LAT/PIV import는 별도 base Python의 isolated 모드로 통과했다. `outputs/security-portable-runtime.json`.
- 전체 payload를 연결한 실제 ASAR에서 CNG 등록·온라인 승인·DPAPI·회수·결과 목록 접근을 검증했다. `outputs/security-check/792561eb-687d-4b12-a930-d5c9f1c392d4/verification.json`. 새 실행 환경과 전체 파일 검증을 포함한 이 PC의 첫 화면 진입은 약 177초였다. 검증을 생략하지 않으며 시작 진행 상태를 표시한다. 시작 시간 최적화가 남은 성능 항목이다.
- 최종 내부 설치본의 등록·회수·DPAPI 재검증: `outputs/security-check/0f64ac73-bb5b-49c0-acfa-6c29a71ed1c8/verification.json`. 설치 파일 hash·미서명 상태·검사 수·남은 항목은 `outputs/security-implementation-status.json`에 기록했다. 전체 Node 보안 검사 31개, attestation 14개, 내부 JWE 1개, artifact 2개와 기존 영상/색상/상호작용 검사를 통과했다.
- 암호화/복호화는 성능 보고서에 독립 항목으로 기록한다. `artifact_encrypt/decrypt`는 암호 연산 시간이며 파일 I/O 시간은 기존 save/read 단계에 남는다. 전체 payload 검증은 앱 시작 비용이며 추론 시간에 합산하지 않는다.

## 0.1.26 시작 성능과 5C NFC 지원

시작 지연 후속 작업은 [Desktop 성능 문서의 TODO와 축소 후보 기록](DESKTOP_PERFORMANCE.md)에 정리했다. `perf/slim-protected-runtime` 브랜치의 공통 PyTorch 구조는 새 앱이 필요하며 기존 배포본에 자동 적용하지 않는다.

2026-10-17 후속 시험에서는 축소 엔진으로 제공 CT/MRI/AP/LAT-LT/LAT-RT 샘플을 실제 GPU 추론했다. 결과 처리에서 발견한 긴 GLB 경로·선택적 NRRD 원점 읽기 오류를 `0.1.27-runtime-slim.2`에서 수정하고, 완료된 추론 결과를 재사용해 5종 측정·Overlay 및 CT/MRI 3D 화면을 확인했다. MRI PP500·강화 후보와 Raw 보존도 검사했다. 상세 실패·수정·재검사 근거와 명령은 위 성능 문서에 있다. 이 검증은 내부용 패키지와 격리 저장소에서 수행했으며, 아래 고객 현장·실물 동글 검증을 대신하지 않는다.

시작 시 모든 서명·파일 목록·내용 해시·모델 연결 검사를 유지한다. 디렉터리 열거 시 얻은 파일 종류를 재사용해 중복 조회를 줄였다. 파일 크기·수정 시각만 믿는 캐시는 사용하지 않는다. 같은 크기·시각으로 변조한 파일, 추가 파일, junction, 잘못된 서명·모델 조합은 계속 거부한다.

앱을 실행할 때 현재 프로필의 `userData/startup-performance.json`에 Electron 준비, helper 검증, payload의 index/목록/모델 연결/해시 검사, 결과 키 준비, 라이선스 초기화, 화면 준비 시간을 기록한다. 환자 정보·개인키·모델 내용은 넣지 않는다. 시간 단위는 ms이며 `totalMs`는 main 모듈 진입부터 첫 화면 표시까지다. OS가 실행 파일을 여는 시간은 포함하지 않는다. 진단 파일 저장 실패가 정상적인 앱 실행을 막지는 않는다.

전체 payload만 따로 비교할 때:

```powershell
npm run performance:startup -- PAYLOAD ISSUER_PUBLIC.pem NEW_REPORT.json
# 비교용으로 보관한 이전 verifier를 사용하려면 마지막 인자에 해당 payload.cjs 경로를 준다.
# 같은 디렉터리에 그 버전의 payload-verifier.cjs와 공통 검증 모듈이 있어야 한다.
npm run performance:startup -- PAYLOAD ISSUER_PUBLIC.pem BASELINE_REPORT.json BASELINE_VERIFIER.cjs
# Node 단독 진단은 실제 Desktop 시간과 분리한다.
npm run performance:startup -- --node PAYLOAD ISSUER_PUBLIC.pem NODE_REPORT.json
```

기본 명령은 앱과 같은 Electron으로 실행한다. 보고서는 CPU·메모리·Node/Electron 버전, verifier/worker SHA-256, payload 버전과 index SHA-256, 단계별 시간·worker별 처리량을 기록한다. 이전 verifier에 단계별 측정이 없으면 `wallMs`만 비교한다. 출력 경로는 새 파일이어야 한다. OS 파일 캐시를 비우지 않으므로 재부팅 직후/반복 실행 조건을 혼동하지 않는다. 다른 작업을 동시에 돌리지 않고 같은 payload·장비에서 순차 비교한다.

2026-10-16 이 PC의 동일 payload(88,909개 파일, 22,786,400,359 bytes) 실험 기록:

| 환경 / 변경 후보 | 전체 payload 검사 | 해석 |
| --- | ---: | --- |
| Node 단독, 기존 코드 | 34.87초 | Desktop 시작 시간으로 사용할 수 없음 |
| Node 단독, 목록 조회·버퍼·파일 순서 변경 | 29.02초 | Electron에서 재검증 필요 |
| Electron, 기존 코드 | 114.54초 | 같은 QA payload 경로의 대조 실행 |
| Electron, 위 후보 및 original-fs | 119.59초 | 전체 개선 확인 안 됨 |
| Electron, 비동기 파일 읽기 후보 | 118.75초 | 전체 개선 확인 안 됨 |

Node의 개선율을 Desktop 개선율로 사용하지 않는다. 버퍼 재사용·큰 파일 우선 배분·original-fs·비동기 읽기는 최종 코드에서 제외했다. 단일 worker도 제한 시간 안에 끝나지 않아 제외했다. 5천 개 작은 파일만 검사한 미세 시험의 개선 역시 전체 실행 개선으로 환산하지 않는다. 최종 변경은 목록 열거 시 중복 조회 제거와 계측이다. 기존 177초 기록은 같은 실행 조건의 대조가 아니므로 직접 속도 배율을 계산하지 않는다. 각 값은 단일 실행이며 통계적 성능 보장이 아니다. 보고서는 `outputs/startup-{baseline-control,optimized-control,electron-original-baseline,electron-native-fs,electron-async}-20261016.json`에 있다.

최종 0.1.26 ASAR의 실제 앱 검사에서는 첫 화면 표시까지 **166.48초**, payload 전체 검증 165.00초, 그중 목록 열거 1.41초·내용 해시 163.33초였다. 라이선스 초기화는 0.78초, 화면 준비는 0.21초였다. 앱 전체 실행과 별도 verifier 실행은 구분한다. **전체 시작 시간 개선은 확정하지 않았고, 해시 검증 지연은 남은 병목이다.** 별도 utility process 후보도 122.13초로 개선을 확인하지 못해 적용하지 않았다.

최종 검증 기록: `outputs/security-check/9ba284d4-2ce7-4cb6-af80-f05863b2464d/{verification,startup-performance}.json`. 실제 ASAR에서 CNG 등록·온라인 승인·DPAPI·회수 후 결과 목록 접근과 같은 크기·수정 시각의 파일 변조 거부를 통과했다. Node 보안 검사 32개, PIV 합성 검사 17개, JWE 검사 1개, TypeScript 검사를 통과했다. 모델 추론 코드가 바뀌지 않아 환자 추론은 재실행하지 않았다.

내부용 설치 파일은 `release/internal/EXMO-Atlas-Internal-Setup-0.1.26.exe`다. SHA-256: `937c48ffa4e78d3bcb9fdd143b14d0c15d871a1f037f730d700dbc629a95a461`. 미서명 내부 검증용이며 22.8GB 엔진은 이 설치 파일에 포함되지 않는다. 이번 검증은 기존 서명 엔진을 별도로 연결했다. 고객용 서명 설치본·새 PC 설치 검증과 혼동하지 않는다.

5C NFC(사용자 전달 firmware 5.8)와 Nano의 공통 PIV 검사 및 합성 테스트 17개를 통과했다. 실제 인증서 chain·PC/SC·재연결은 장치 도착 후 검증한다. 서버는 제공된 뒤 SSH로 배포한다. 그때 호스트·SSH 계정/포트·운영 도메인·관리 권한·백업 위치를 확인하고 위 서버 배포/복구 절차를 실행한다. SSH 자격이나 운영 발급 개인키는 저장소에 넣지 않는다.

## 출시 전 실제 환경에서 남은 확인

1. YubiKey 5C NFC / 5C Nano 실물의 프로비저닝·9E 서명·9D ECDH·PC/SC 드라이버·재연결·절전 복귀. 구매 장치는 5C NFC·firmware 5.8로 전달받았으며, USB-C keychain/Nano 공통 검증과 합성 테스트는 반영했다. 실물 연결 검증은 아직 수행하지 않았다.
2. 실제 기관/서버의 HTTPS 인증서·방화벽·백업 보관·서버 시간·운영 계정·장애 복구. 배포할 서버 접근 정보가 없어 원격 배포하지 않았다.
3. 실제 Authenticode 서명 인증서를 사용한 고객 NSIS, 완전히 새 PC에서 설치/업데이트/삭제/복구와 전체 환자 워크플로. 현재 인증서와 추가 PC가 없다.
4. 고객 관리자 권한의 추출/변조 공격에 대한 별도 보안 평가. 로컬 실행 모델은 메모리와 GPU에 복호화 상태로 존재한다. CNG software KSP, Python/ASAR 검사와 동글 인증은 절대 추출 방지나 TPM 보장으로 표현하지 않는다.

이 항목들을 통과하기 전에는 “고객 현장 전체 검증 완료”라고 표시하지 않는다. 현재 자료는 구현·로컬 통합 검증·운영 준비 산출물이다.

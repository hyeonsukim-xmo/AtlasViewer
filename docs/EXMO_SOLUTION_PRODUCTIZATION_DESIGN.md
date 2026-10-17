# EXMO 솔루션별 제품화·계정·결과 동기화 설계

작성: 2026-10-17. 기준 코드: `d474eea`, `feat/desktop-security`, Desktop `0.1.27-runtime-slim.3`.

**이 문서는 다음 제품 구조의 설계다. 구현 완료 보고가 아니다.** 이번 작업에서 분석 코드·모델·라이선스 발급·기존 데이터는 변경하지 않는다. 실행 계획은 [구현·검증 계획](EXMO_SOLUTION_PRODUCTIZATION_PLAN.md), 홈 화면 검토용 모형은 [HTML](prototypes/solution-home.html)에 있다. 기존 구현/시험 사실은 [제품 보안 runbook](EXMO_PRODUCT_SECURITY_RUNBOOK.md), [성능 기록](DESKTOP_PERFORMANCE.md), [오류 처리](DESKTOP_DIAGNOSTICS.md)를 기준으로 한다. 이전 제품 문서의 오래된 구현 상태보다 현재 코드와 이 문서의 **현재/계획 구분**을 우선한다.

## 1. 사용자 요구와 결정

| 구분 | 기준 |
| --- | --- |
| 확정 | 하나의 Desktop 프로그램을 유지하고 CT·MRI·X-ray를 각각 구매 가능한 솔루션으로 제공한다. 이후 솔루션이 추가된다. |
| 확정 | YubiKey는 PC 1대에 귀속한다. 관리자 승인으로 장비를 이전하는 절차를 둔다. |
| 확정 | 계정의 주목적은 분석 결과를 서버에 보관하고 사용자에게 웹·태블릿 열람을 제공하는 것이다. |
| 확정 | 원본 영상은 로컬에 보존한다. Mask·측정·모델링/렌더링 결과는 서버로 전송할 수 있도록 설계한다. |
| 유지 | 온라인 최초 활성화/갱신, 최대 7일의 서명된 오프라인 유예, 고객 분석마다 PC+YubiKey 증명. 진행 중 작업은 안전하게 마무리한다. |
| 유지 | Web/태블릿에는 신규 영상 입력·분류·Segmentation 기능을 제공하지 않는다. Mask는 일반 사용자에게 직접 배포하지 않는다. |
| 기본안 | 소유권은 개인 계정보다 **기관 workspace**에 둔다. 계정은 기관 구성원·게시자·열람자 역할을 갖는다. 퇴사해도 기관 데이터는 남는다. |
| 기본안 | Desktop 일상 분석은 클라우드 로그인에 종속시키지 않는다. 계정 로그인은 활성화 관리, 솔루션 관리, 결과 게시·서버 조회에 사용한다. |
| 기본안 | 첫 버전은 사용자가 검토 후 선택한 결과를 게시한다. 기관 승인 없이 자동 전송을 켜지 않는다. |
| 기본안 | 원격 기본 열람은 측정·QC·3D·선택된 대표 Overlay다. 전체 slice 스크롤은 별도 표시용 영상 전송 정책이 필요한 확장이다. |

판매명은 미정이다. 문서의 `CT Thigh`, `MRI Thigh`, `X-ray Lower Extremity`는 가칭이다. 영구/기간제, 저장 용량·보존 기간·외부 공유 정책은 계약 값으로 둔다. 미정인 판매 조건을 코드 상수로 확정하지 않는다.

### 1.1 세 가지 권한을 분리한다

1. **분석 권한:** 이 PC와 YubiKey가 어떤 솔루션을 실행할 수 있는가.
2. **계정/데이터 권한:** 이 사용자가 어느 기관의 어느 결과를 게시·조회할 수 있는가.
3. **설치 상태:** 이 PC에 필요한 검증된 프로그램·모델 패키지가 준비됐는가.

계정 로그인 성공, 파일 설치 성공, 동글 연결 중 하나만으로 분석 권한을 부여하지 않는다. 반대로 로그인 만료·서버 저장 공간 부족 때문에 유효한 로컬 분석 권한을 취소하지 않는다. 이전 결과 열람은 신규 분석 계약과 분리한다.

## 2. 현재 코드에서 확인한 변경 필요점

| 현재 근거 | 확인한 상태 | 설계에서 바꿀 부분 |
| --- | --- | --- |
| [main.tsx](../desktop/ui/main.tsx) | `analyses`에 3개 항목 고정. `Analysis`별 workspace와 최근 결과. 홈 상태 조회 한 항목 실패 시 전체 Promise가 실패하고 예외를 삼킴 | 솔루션 목록과 상태를 registry에서 구성. 항목별 상태/진단 표시. 같은 modality에 복수 솔루션 허용 |
| [imaging.ts](../desktop/ui/imaging.ts) | `Analysis = ct / mri / xray`, 결과에 solutionId·기관·게시 버전 없음 | modality는 보존하고 solutionId·workflowId·result revision 추가 |
| [license-protocol.cjs](../desktop/security/license-protocol.cjs) | v2 lease: `engines=[ct,mri,ap,lat]`, modelDigests 최대 6개, strict 필드 검사, 16 KiB 한도 | 버전이 다른 솔루션별 lease를 추가. 기존 v2 필드에 임의 추가하면 JS/Python 모두 거부함 |
| [license-server.cjs](../scripts/security/license-server.cjs) | SQLite 발급 원장. license 1개에 installation/dongle UNIQUE, 전체 계약 만료, engine 목록. 원격 사용자/기관 관리 없음 | 기관·계정·개별 솔루션 계약·설치 배정·감사 원장 추가 |
| [runtime.cjs](../desktop/security/runtime.cjs), [model_security.py](../desktop/model_security.py) | PC+동글과 모델 digest 검증, 작업별 challenge/서명/키 봉투. engine만 검사 | solution/workflow/model/recipe 연결을 main과 Python이 모두 검증 |
| [payload.cjs](../desktop/security/payload.cjs) | 모든 6개 모델과 5개 환경을 요구하는 전체 payload. 실행 전 내용 해시 검사 | 설치 선택에 따라 필요한 패키지 집합만 검증하는 새 manifest. 없는 미구매 솔루션을 손상으로 판정하지 않음 |
| [imaging.cjs](../desktop/imaging.cjs), [model-runner.py](../desktop/model-runner.py) | preview/결과 worker가 CT 환경을 사용. CT CUDA는 AP/공용 PyTorch를 사용 | Reader/보안 runtime을 추론 상품에서 분리. CT 설치가 X-ray 모델 구매를 요구하지 않게 의존성 분리 |
| [result-storage.cjs](../desktop/security/result-storage.cjs) | Windows 사용자 DPAPI로 결과 저장소 키 보호, 기관 복구 봉투. mask 암호화 | 로컬 키는 유지. 서버 전달용 결과별 키를 별도로 생성; 로컬 전체 저장소 키를 서버에 보내지 않음 |
| [main.cjs](../desktop/main.cjs) | 내부용/고객용 저장소 분리, payload 검사 후 UI 시작 | 작은 공통 앱을 먼저 검증해 표시하고, 선택된 분석 runtime은 사용 전에 검증 |
| [README](../README.md) | Web은 viewer, 서버 결과 수신은 계획 상태 | 계정·결과 API·저장·동기화·원격 viewer는 새 구현 대상 |

이번 제품화는 기존 모델의 전처리·추론·좌표 복원·정밀도를 바꾸는 작업이 아니다. reader/runtime 분리가 실제 import 경로나 출력에 영향을 주는지는 구현 단계의 검증 대상이다. 모델 파일의 동일성만으로 통합 검사를 대체하지 않는다.

## 3. 제품·워크플로·모델을 분리한 목록

| 안정적인 solutionId | 표시 가칭 | modality | workflowId | 필수 모델 |
| --- | --- | --- | --- | --- |
| `exmo.thigh.ct` | CT Thigh | CT | `thigh-ct-v1` | ct |
| `exmo.thigh.mri` | MRI Thigh | MRI | `thigh-mri-water-v1` | mri |
| `exmo.lower-extremity.xray` | X-ray Lower Extremity | X-ray | `lower-extremity-projection-v1` | ap, lat_lt, lat_rt, xray-classifier |

- `solutionId`는 판매/권한/결과 이력의 기준이며 이름·버전과 분리한다. 표시명 변경으로 기존 결과를 다른 상품으로 분류하지 않는다.
- X-ray AP·LAT-LT·LAT-RT는 첫 상품의 구성요소다. 내부 모델 4개를 구매자에게 4개 상품처럼 노출하지 않는다. 화면 순서는 **Lt → AP → Rt**, 없는 view는 빈 상태로 표시하고 있는 영상은 사용한다.
- bundle SKU는 계약 발급 시 solution entitlement 여러 개로 풀어 기록한다. 클라이언트의 `bundle=true` 같은 우회 권한은 만들지 않는다.
- 같은 CT에 새 분석이 추가돼도 modality enum을 늘리지 않는다. 새 solutionId와 workflow 연결을 추가한다.
- catalog는 설명/호환성 데이터, entitlement는 실행 허가, installed manifest는 실제 파일이다. catalog를 조작하거나 미구매 모델을 복사해도 실행 허가가 생기지 않는다.

### 3.1 Registry 계약

각 항목은 `solutionId`, 표시명/설명 번역키, modality 목록, workflowId, 지원 입력, 측정 결과 schema, viewer adapter, 필수 capability, runtime/model 의존성, 앱 최소 버전, 배포 상태를 가진다. 서버가 임의 JS/Python 명령·실행 경로·HTML을 보내는 구조는 사용하지 않는다.

앱에는 허용된 workflow/viewer adapter가 코드로 등록된다. 서명된 catalog에 있어도 adapter를 모르면 **앱 업데이트 필요**로 표시한다. 기존 adapter로 처리 가능한 새 상품은 서명된 데이터 추가로 지원하고, 새 동작이 필요한 상품은 앱 릴리스를 거친다. 새 모델 버전과 새 상품 생성은 별개다.

실행 패키지 manifest에는 정확한 model/recipe/runtime digest와 adapter compatibility가 들어간다. `latest`를 실행 시점에 자동 선택하지 않는다. 결과는 실행 당시 버전 전체를 보존한다.

## 4. YubiKey와 솔루션 라이선스

### 4.1 “키에 라이선스 등록”의 구현 의미

사용자에게는 **이 키에 CT·MRI 사용권이 등록됨**으로 보여준다. 실제 계약 목록은 서버 원장과 EXMO 서명 lease에 있으며 YubiKey의 공개키 지문과 PC 설치 키에 묶인다. 새 솔루션을 구매하면 원장을 갱신하고 새 lease·모델 키 봉투를 받아 설치한다. YubiKey의 개인키를 재생성하거나 상품마다 PIV 슬롯을 추가하지 않는다.

현재 고객 경로의 PIV `9e`는 소유 증명, `9d`는 모델 키 봉투 해제에 사용한다. 이 개인키 및 attestation을 재사용한다. attestation은 키가 하드웨어에서 생성됐다는 근거이며 상품 구매 사실은 서버가 판정한다. 시리얼 번호만으로 소유권을 증명하지 않는다. [Yubico PIV attestation](https://docs.yubico.com/yesdk/users-manual/application-piv/attestation.html)

동글의 추가/분실/교체는 기관 운영자가 관리한다. 고객 설치 프로그램은 빈 슬롯 여부를 확인하지 않은 키 생성, PIV reset, 점유 슬롯 덮어쓰기를 실행하지 않는다. 솔루션 구매·갱신 UI에서 하드웨어 provisioning 기능을 제공하지 않는다.

### 4.2 장비 귀속과 이전

- 기본: 기관 1개 + 활성 installation 1개 + 등록 YubiKey 1개. 다른 PC나 다른 동글의 키 봉투 재사용을 거부한다.
- 현재 installation/CNG/DPAPI는 **Windows 사용자 프로필의 설치 신원**이다. 하드웨어 UUID만으로 PC를 인식하는 방식이 아니다. 같은 PC의 다른 Windows 사용자에게 자동으로 동일 승인·결과 접근이 생기지 않는다.
- V1은 기존 사용자 프로필 경계를 유지한다. 여러 EXMO 계정이 동일한 Windows 프로필에서 서버에 로그인할 수 있지만 로컬 데이터 접근은 기존 Windows 프로필 권한을 따른다. 기관 공용 Windows 계정 사용 시 EXMO 로그아웃이 로컬 데이터 보안 경계라고 주장하지 않는다.
- 여러 Windows 사용자에게 한 설치 신원을 공유해야 하는 요구가 확정되면 machine-level service/ACL/키 보관/IPC 인증을 별도 구현한다. 등록 ID 복사나 DPAPI 우회로 해결하지 않는다.
- 이전: 새 PC 등록 → 기관 관리자 승인 → 이전 installation 회수 → 새 binding/봉투 발급 → 결과 복구/열람 검증. 원장에는 predecessor를 남긴다.
- 복구할 결과의 `originStoreId`/`originResultId`/`analysisRevision`은 그대로 옮긴다. 새 PC는 `uploaderInstallationId`만 달라지며 서버가 승인한 origin 이관 연결을 사용한다. 결과 ID를 새로 만들어 게시하거나 회수된 구 PC의 신원으로 요청하지 않는다(§9.1).
- 구 PC가 오프라인이면 기존 lease 만료까지 겹칠 수 있다. 엄격한 동시 사용 0건을 요구하는 이전은 이전 PC의 해제 증명 또는 잔여 유예 만료 후 새 권한 발급이 필요하다. 네트워크 없이 즉시 회수를 보장하지 않는다.

### 4.3 솔루션별 상태

장비 전체 상태와 상품별 상태를 분리한다. 예: MRI가 만료돼도 CT가 유효하면 CT는 실행한다. 한 모델 버전이 회수돼도 무관한 상품을 정지시키지 않는다. 장비 분실·동글 회수는 전체 신규 분석을 막는다.

상품 entitlement는 `entitlementId`, `solutionId`, `validFrom`, `validUntil`(영구권은 null), `state`, `revision`, `capabilities`와 허용 execution binding을 가진다. execution binding은 `(solutionId, workflowId, modelDigest, recipeDigest)`의 명시적 조합이다. recipe는 가중치 외 설정·후처리 정의도 고정한다.

실행 허가의 교집합:

```text
신규 분석 가능 = 장비 lease 유효
              AND 해당 solution entitlement 유효
              AND PC·YubiKey 작업별 증명 성공
              AND 해당 workflow/model/recipe 조합 허용
              AND 설치 파일·의존성 검증 성공
              AND 입력 조건 및 결과 보호 저장소 준비
```

로그인 토큰과 구매 목록 UI는 이 식을 대체하지 않는다. classifier·재추론·Mask/측정을 바꾸는 새 후처리 후보는 해당 상품의 새 실행 허가를 받는다. 이미 확정된 결과의 읽기·slice decode·동일 Mask의 표시용 mesh 생성/재시도는 공통 reader 기능이다. 표시용 mesh를 별도 `derive` 상품 권한으로 묶지 않는다.

reader의 mesh 요청은 등록된 결과 revision, 확정된 Mask/sideMask digest, 표시 recipe/version에만 결합한다. 새 입력·임의 Mask·새 후처리를 받거나 Mask/측정/좌우 값을 바꾸는 호출은 거부한다. 이미 생성한 variant로 돌아가는 것과 새로운 variant를 계산하는 것을 구분한다. 기존 코드의 `variant → finalize`가 양쪽 역할을 하므로 새 계산 경로에는 main/worker 허가를, 기존 표시 경로에는 읽기 검사를 적용한다.

추론 후 확정된 Mask/측정/표시 recipe를 원자적으로 저장한 뒤 3D를 예약한다. 앱 중단·상품 만료·동글 제거·모델 제거 후에도 이 snapshot으로 3D를 복구한다. 필요한 과거 reader 의존성은 보존한다. 확정 snapshot이 없는 불완전 결과는 완성된 것으로 꾸미지 않고 복구 불가 사유를 표시하며, 재추론에는 새 권한을 요구한다.

### 4.4 lease와 작업 허가 버전

새 라이선스는 별도 `exmo-license-v3`/audience와 `/v3` endpoint를 사용한다. 기존 v2의 exact-fields 검사를 느슨하게 만들지 않는다.

| 문서 | 필수 내용 |
| --- | --- |
| Device lease v3 | issuer/audience/kind/schema, orgId, binding, nonce, iat, exp, renewAfter, device decision, sequence, entitlement revision, 솔루션별 상태·기간·capability·execution binding |
| Model access | 기존 PC+동글 이중 봉투, modelDigest, 수신 설치 키, profile. possession만으로 실행 허가 아님 |
| Run authorization v2 | runId, solutionId, workflowId, capability, engine, modelDigest, recipeDigest, packageSetDigest, jobDigest, leaseDigest, worker nonce, keyDigest, iat/exp, PC/동글 서명 |
| Result mutation authorization v1 | 새 후처리 전용: runId, solutionId/workflowId, 원본 origin/revision·Mask digest, 허용 recipe/package digest, job/lease digest, worker nonce, iat/exp, PC/동글 서명. 모델 키 봉투와 독립 |

후처리 worker는 result mutation의 정확한 필드와 허용 recipe를 검증한다. 기존 model-run 필드를 느슨하게 만들거나 Mask를 읽는다는 이유로 허가를 생략하지 않는다. 표시 mesh는 이 변경 허가가 아니라 §4.3의 불변 결과 읽기 검사만 사용한다. 후처리 결과는 새 revision에 저장한다.

서명 lease 크기는 기본 최대 128 KiB, 솔루션 최대 64개, execution binding 최대 256개로 제한하는 v3 계약을 제안한다. body/문자열/배열 수를 검증하며 초과는 명시적으로 거부한다. 서비스가 이 한도에 근접하면 버전 있는 분할 grant로 변경한다. 기존 16 KiB·6-model 한도를 조용히 제거하지 않는다.

권한 변경은 원장 transaction에서 revision을 올린다. 클라이언트는 sequence 역행, 구 revision 복원, 다른 org/binding/nonce, allow로의 무승인 복귀를 거부한다. main과 Python worker가 동일한 v3 claim/execution 조합을 독립적으로 검사한다. 공유 모델을 두 상품이 사용해도 solutionId를 바꿔 권한을 우회할 수 없어야 한다.

### 4.5 장애·유예·작업 수명

- `exp = min(서버가 발급한 최대 7일 유예, 장비 정책)`이며 상품 계약 만료는 각 entitlement에서 추가로 검사한다. 앱 재시작·계정 로그인으로 유예를 연장하지 않는다.
- 온라인 갱신 주기 기본 24시간, 실패 시 짧은 초기 재시도 후 지수 backoff+jitter(상한 15분). 이미 서명된 거부 응답을 받으면 다음 신규 작업부터 반영한다. 단순 통신 실패는 회수 응답이 아니다.
- 대기열에 넣은 시점이 아니라 **각 case 실행 승인 시점**에 다시 검사한다. 시작된 작업은 해당 승인 snapshot으로 안전하게 종료한다. 같은 run의 필수 결과 확정은 허가 수명에 포함한다. 무한히 새 작업을 이어붙일 수 없다.
- 짧은 run authorization의 `exp`는 추론 worker의 최초 수락 기한이다. 수락된 run은 지정된 입력·모델에 한정해 완료하며, 기한 경과로 진행 중 추론을 강제 종료하지 않는다. 다른 입력/추론 worker의 새 실행에 재사용하지 않는다. main은 이 run에 결합된 결과 확정 단계까지만 완료시키며, 확정 후 표시용 3D는 별도 reader 검사로 처리한다.
- 동글 제거·만료·회수 뒤 신규 case/재추론/새 후처리는 차단한다. 원래 승인된 실행의 finalize를 완료하고 측정·Overlay를 보존한다. 확정 결과의 3D 준비와 재시도는 §4.3의 읽기 정책을 따르므로 재시작 후에도 만료된 추론 허가를 재사용할 필요가 없다.
- 시계 역행/캐시 변조는 온라인 재확인 필요. YubiKey 기반 인증이 PC 시계와 소프트웨어 snapshot rollback까지 완전히 막는다고 약속하지 않는다.

## 5. 계정의 역할과 로그인

### 5.1 소유권/역할

| 주체 | 로컬 분석 | 서버 게시/조회 | 관리 |
| --- | --- | --- | --- |
| 유효 장비의 Windows 사용자, EXMO 로그아웃 | 유효 솔루션으로 가능 | 신규 게시·서버 조회 불가 | 기존 로컬 결과 열람 가능, 온라인 관리 불가 |
| 기관 analyst | 장비 라이선스가 따로 필요 | 허가된 workspace에 게시·열람 | 자기 전송 작업 취소 |
| 기관 reviewer | 클라우드 역할로 장비 실행권이 생기지 않음 | 배정된 workspace 결과 열람·비교 | 승인된 결과 검토 상태 기록 |
| 기관 device/license manager | 장비 정책과 별개 | 기본 임상 데이터 조회권 없음 | 장비 배정·솔루션 설치·계약 상태·이전 요청 |
| 기관 data admin | 별도 | workspace 구성·보존·삭제·권한 관리 | 임상 조회는 별도 역할 부여 |
| EXMO 운영자 | 고객 임상 권한 없음 | 기본 환자 데이터 조회권 없음 | 계약/키/패키지 발급, 감사된 지원 절차 |

역할은 조합할 수 있다. 최초 기관 관리자가 임상 조회를 자동으로 모두 얻는 방식은 피한다. 기관 초대·승인을 받은 계정만 workspace에 가입한다. 이메일 도메인 일치나 공개 회원가입만으로 병원 데이터에 접근시키지 않는다.

### 5.2 인증 흐름

Desktop은 표준 OIDC Authorization Code + PKCE(S256)를 시스템 브라우저에서 수행한다. 앱이 비밀번호를 수집하거나 로그인 WebView에서 쿠키를 읽지 않는다. main이 일회용 state/nonce/verifier와 `127.0.0.1` 임시 callback을 관리하고 성공·시간 초과 후 listener를 닫는다. redirect·issuer·audience·nonce를 엄격히 검증한다. 공개 클라이언트에 숨길 수 없는 client secret을 포함하지 않는다. [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html)

ID token은 신원 확인용이고 제품 권한/결과 API의 만능 토큰이 아니다. access token은 API audience/scope를 제한하고 기본 10분, refresh는 회전/재사용 감지 및 서버 logout 회수를 적용한다. 수명은 서비스 정책이다. refresh token은 main의 OS 보호 저장소에 보관하고 renderer/localStorage/로그/URL로 전달하지 않는다. [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)

인증 공급자를 직접 구현하지 않는다. 서버 환경 확정 시 표준 OIDC 공급자 하나를 정하고 `iss/sub`를 사용자 ID로 사용한다. 이메일 변경으로 사용자를 새로 만들거나 데이터 소유권을 이전하지 않는다. 기관 SSO는 이후 같은 공급자 연결을 통해 추가한다. EXMO 계정과 라이선스 YubiKey는 역할이 다르며 동글이 꽂혀 있다는 이유로 사람의 로그인을 인정하지 않는다.

Web은 서버 세션/BFF와 HttpOnly·Secure·SameSite cookie, CSRF 보호를 기본으로 한다. 태블릿 V1은 같은 결과 viewer의 반응형 Web/PWA로 제공한다. 네이티브 앱이 필요하면 동일 결과 API와 플랫폼 표준 로그인만 추가하며 분석 엔진은 넣지 않는다.

### 5.3 로그인 상태와 운영

- Desktop은 기존 유효 세션을 복원해 곧바로 홈으로 진입한다. 로그인 화면을 매번 전체 분석 앞에 세우지 않는다.
- 로그인 실패/만료/로그아웃: 서버 조회 캐시와 표시를 해당 계정 기준으로 비우고 전송을 `needs_login`으로 둔다. 로컬 입력·결과·license·키는 삭제하지 않는다.
- 오프라인: 유효한 장비 권한으로 분석/로컬 열람. 결과 게시 선택은 outbox에 남기며 계정/권한을 온라인에서 재확인한 후 전송한다. 오프라인에서 새 계정 로그인을 흉내 내지 않는다.
- 다른 계정으로 로그인해도 outbox의 org/workspace/게시자 배정을 자동 변경하지 않는다. 기존 게시자의 재로그인 또는 새 게시자의 명시적 인수 + 서버 권한 검사가 필요하다.
- 기관 A 장비에서 기관 B 계정으로 로그인해도 A 결과를 B로 게시할 수 없다. 등록 기관을 바꾸는 작업은 장비 이전/데이터 이관 절차이며 로그인 전환과 다르다.
- 현재 Windows DPAPI는 다른 Windows 사용자 보호에는 유용하지만 같은 Windows 사용자 권한의 악성 앱까지 차단하는 수단은 아니다. 계정 UI를 추가한다고 로컬 파일이 사용자별로 격리되지는 않는다. [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

## 6. 설치·추가 구매·업데이트

### 6.1 배포 단위

**하나의 공통 앱 + 선택한 솔루션 패키지**를 사용한다. CT용/MRI용/X-ray용 앱 소스를 각각 fork하지 않는다. 내부용과 고객용 빌드의 issuer/profile/서명/저장소 구분은 유지한다.

| 단위 | 포함 | 라이선스와 관계 |
| --- | --- | --- |
| App shell | 홈·계정·license·설치 manager·기본 결과 viewer·진단 | 앱 실행 및 기존 결과 열람 |
| Reader/security runtime | 기존 결과 decode, metadata/Overlay·표시 mesh 준비/복구, 암호화, PIV | CT 상품 미구매여도 기존 결과 읽기/동글 인증에 필요 |
| Versioned runtimes | CT/MRI/AP/LAT/classifier의 정확한 의존성 집합 | 공유 가능한 **동일 파일**만 공용. 모델 구매권과 무관 |
| Model packages | 서명 manifest + 암호화 가중치 + 검증된 runner/recipe | 해당 솔루션 grant 없으면 실행 불가 |
| Viewer adapters | 결과 schema/class/단위/geometry 해석 | 분석 만료·모델 제거 후에도 과거 결과에 필요한 reader 유지 |

공용 PyTorch는 CT CUDA와 X-ray에서 공유하되 X-ray 모델 자산을 CT 필수 항목으로 만들지 않는다. preview와 classifier가 현재 CT 환경에 기대는 부분을 명시적으로 분리해야 한다. 패키지 이름만 쪼개는 작업으로 해결되지 않는다. 정확한 dependency closure는 현재 파일 inventory/import/실제 loader 검사로 산출한다.

### 6.2 최초 설치와 사용

1. 서명된 공통 설치 프로그램 실행. 기존 내부/고객 profile과 저장소를 유지한다.
2. 작은 공통 프로그램의 무결성을 확인하고 설정 화면을 표시한다. 아직 분석은 실행하지 않는다.
3. 온라인에서 기관의 관리 권한으로 로그인하고 PC 등록 요청·YubiKey attestation을 제출한다. 구매 계약/키 배정은 서버가 확인한다.
4. 관리자가 기관/PC/키를 승인한다. 새 권한과 정확한 모델 봉투를 발급받는다.
5. **이 키에서 사용 가능한 솔루션**을 보여준다. 구매한 항목만 기본 목록에 있고 설치할 항목을 선택한다. 최초 권장 선택은 구매 항목 전체이며 용량과 필요한 공간을 표시한다.
6. 패키지 다운로드/전송 매체 가져오기 → staging → 서명/파일 해시/의존성/호환성 검사 → 설치 확정. 단일 상품 실패는 다른 정상 상품을 막지 않는다.
7. 홈에 준비된 솔루션과 실패한 설치의 조치가 보인다. 설정용 관리자 로그아웃 후에도 유효한 로컬 분석은 가능하다.

기존 활성화 파일/관리 CLI는 운영 복구 경로로 유지하되 새로운 상품 권한을 수정하는 UI 편집 파일로 사용하지 않는다. 구매 절차 자체의 결제/견적 시스템은 V1 앱 범위 밖이다.

### 6.3 패키지 작업의 불변 조건

- 별도 새 payload schema는 `installed packages + dependency graph + digest`를 검증한다. 빠진 미선택 상품과 빠진 필수 파일을 구별한다. 알려지지 않은 추가 실행 파일/junction/path traversal/혼합 profile은 거부한다.
- 다운로드는 승인된 catalog의 digest로 식별하며 임의 URL/파일경로 실행을 허용하지 않는다. URL은 짧은 수명이며 설치 권한과 실행 권한을 따로 검사한다.
- 재개 다운로드는 최종 전체 hash를 확인한다. 충분한 공간은 기존 버전+staging+작업 임시 공간을 포함해 계산한다.
- immutable version directory에 설치하고 active set pointer를 atomic 교체한다. journal로 전원 중단 후 이전 정상 버전 또는 새 완성 버전만 선택한다. `.partial`은 실행하지 않는다.
- 실행 중 job은 시작 당시 packageSetDigest/version을 pin한다. 실행 중 파일 덮어쓰기·공유 runtime 제거·강제 앱 재시작을 하지 않는다.
- downgrade/rollback도 현재 승인된 digest인지 확인한다. 회수된 모델을 “이전 버전 복구”로 되살리지 않는다.
- 솔루션 제거는 모델/미사용 runtime만 제거하고 입력·결과·서버 사본을 삭제하지 않는다. reader와 다른 상품의 공유 의존성을 유지한다.
- 오프라인 매체 설치는 유효한 기존 권한과 해당 digest의 grant가 이미 있는 경우에만 가능하다. 최초 활성화/미승인 새 상품 추가는 온라인 필요다.
- 사용자 선택 대상을 받는 installer는 analysis 관리자 권한을 스스로 만들 수 없다. 설치 프로세스가 고객 빌드를 내부용으로 전환할 수 없어야 한다.

### 6.4 시작 성능

현재 전체 15.77 GB payload 검사는 실제 앱 시작을 지연시킨다. 공통 shell/reader/security는 시작 시 검증하고, **선택된 솔루션의 실행 closure는 검증 완료 후에만 실행**한다. 설치 시 검사를 했다는 이유로 다음 실행에서 내용 검증을 size/mtime로 대체하지 않는다.

정상 홈/과거 GLB 열람은 무관한 모델 전체 검사 완료를 기다리지 않는다. 손상된 CT 패키지는 CT만 차단하고 이미 검증된 공통 reader와 MRI를 사용할 수 있게 한다. 공통 실행 코드 자체의 무결성 실패는 공통 기능을 차단한다. 성능 목표와 같은 PC 실측은 구현 계획의 gate로 관리한다.

## 7. 홈 화면과 상태별 UX

### 7.1 일상 화면

현재 어두운 남색·절제된 glass·임상 표 스타일을 유지한다. 대형 소개 카드, 마스코트, 게임형 진행 UI, 상품 구매 광고를 첫 화면에 넣지 않는다.

```text
EXMO   기관명 / 등록 PC                 장비·키 상태   전송 2건   계정   언어
─────────────────────────────────────────────────────────────────────────
분석 작업 | 결과 | 전송 현황 | 솔루션 관리

분석 작업                           이 PC에서 사용할 수 있는 솔루션
솔루션             Modality   입력 조건           사용권      상태 / 동작
CT Thigh           CT         3D CT·HU            사용 가능   분석 시작
MRI Thigh          MRI        Water sequence      사용 가능   설치
X-ray Lower...     X-ray      Lt / AP / Rt         갱신 필요   결과 보기

최근 결과           로컬 / 서버 / 전체       검색·필터
검사 / 솔루션 / 분석일 / QC / 3D / 게시 상태 / 결과 열기
```

- **분석 선택 먼저 → 영상 등록** 흐름을 유지한다. row 전체를 클릭하면 그 row의 주요 동작을 실행한다. 설치 안 된 항목은 설치 상세, 만료는 권한 상세로 가며 빈 분석 화면에 들어가지 않는다.
- row 안의 독립 버튼은 event propagation을 제어한다. 비교 선택 모드의 결과 row는 **선택 토글**이고, 결과 열기 버튼은 계속 제공한다. 버튼으로 결과를 확인하고 닫아도 비교 선택을 유지한다. 키보드 행 선택·해제·비호환 거부 후 같은 행의 focus를 유지하며, 결과를 닫으면 열었던 버튼으로 돌아온다. 일반 모드 row는 결과 열기다.
- 비교는 선택 개수뿐 아니라 지표 종류·단위·ontology·계산법·촬영 범위의 검증된 호환성을 검사한다. 호환 정보가 없거나 다르면 선택 사유를 표시하고 수치 비교 시작을 막는다. 해제는 항상 가능하며 시작 시 다시 검사한다. Raw/후처리 여부와 촬영 범위 차이는 각 결과에 계속 표시한다.
- 설치/사용권/하드웨어/로그인 상태를 하나의 “준비 안 됨”으로 합치지 않는다. 분석 가능 여부와 가장 먼저 해결할 원인을 표시하고 상세에서 전체 조건을 확인한다.
- 활성 구매 솔루션을 우선, 설치 필요/만료된 보유 솔루션을 다음으로 정렬한다. 미구매 상품은 `솔루션 관리 > 다른 솔루션`에서만 노출한다. 미구매 모델을 백그라운드 자동 다운로드하지 않는다.
- 신규 설치는 간결한 설정 화면, 일상 시작은 작업 목록이다. 동글 없음·오프라인은 상태 배너로 알려주고 기존 결과 열람은 유지한다.
- 최근 결과는 로컬/서버 위치, 동기화 상태, QC 검토 여부를 별도 필드로 표시한다. `서버 저장됨`을 `임상 검토 완료`로 표현하지 않는다. commit이 확인된 결과는 같은 workspace의 서버 목록에도 반영한다. Desktop의 서버 결과 조회는 Desktop 메뉴와 로컬 결과 복귀 경로를 유지하며, 별도 Web 제품으로 전환하지 않는다.
- 관리자는 계약/장비/설치 메뉴, 임상의는 분석/결과 중심으로 보인다. 모델 hash·내부 엔진명·FP32 같은 정보는 상세 진단/QC로 옮긴다.
- 좁은 화면에서는 의미 있는 열을 유지한 채 행 상세를 열고, 상태/주요 동작을 잘라내지 않는다. 키보드 focus·Enter/Space·명시적 label, 텍스트 상태를 제공한다.

### 7.2 대표 상태와 행동

| 상태 | 화면/행의 문구 | 가능한 행동 |
| --- | --- | --- |
| 미활성화 | `이 PC 등록이 필요합니다` | 온라인 등록; 읽을 수 있는 기존 결과 열람 |
| 구매·설치·검증 완료 | `분석 가능` | 해당 workflow 진입 |
| 구매됨·미설치 | `설치 필요 · 예상 용량` | 설치 관리; 기존 결과 보기 |
| 다운로드/검증 | 전송 bytes / 검증 진행률 | 취소·재시도; 다른 준비된 솔루션 사용 |
| 상품 만료 | `MRI 사용권 만료` | 권한 갱신 상세; MRI 기존 결과; 유효 CT 분석 |
| 미구매 | 다른 솔루션 탭의 `미보유` | 제품 설명/관리자 문의 |
| 동글 없음/다른 키 | `등록된 키를 연결하세요` | 기존 결과; 새 분석 대기, 실행 중 job 안전 완료 |
| 인터넷 없음·lease 유효 | `오프라인 사용 · 갱신 필요 시각` | 로컬 분석; 게시 대기 |
| 유예 만료/시간 불신 | `온라인 권한 확인 필요` | 신규 분석 차단; 기존 결과 열람 |
| 로그인 안 됨 | 우측 `로그인 · 결과 동기화 연결` | 로컬 분석; 게시 시 로그인 |
| 서버 저장소 quota 초과 | `전송 보류 · 저장 공간 확인` | 로컬 분석/결과 유지; 관리자가 해결 |
| 패키지 손상/지원 앱 부족 | 해당 상품 `복구 필요` / `앱 업데이트 필요` | 승인된 설치 복구, 정상 상품 유지 |
| 데이터 열람권 회수 | 서버 결과 `접근 권한 없음` | 해당 서버 캐시 정리, 관리자 문의; 기관 로컬 정책 별도 |

`readyToAnalyze`, `readyToReadLocal`, `readyToPublish`, `readyToReadCloud`를 각각 계산한다. UI는 main/API가 계산한 허용 동작과 reason code를 표시한다. 프런트엔드에서 구매 상태만 보고 실행을 승인하지 않는다.

## 8. 서버에 올릴 결과와 Mask 보호

### 8.1 전송 항목

| 데이터 | 기본 처리 | 원격 사용자에게 전달 |
| --- | --- | --- |
| 원본 DICOM/NRRD/NIfTI, 원본 ZIP | 로컬 보존, 자동 전송 제외 | 없음 |
| Native mask | 결과별 암호화 후 비공개 object store | mask/labelmap 다운로드 API 없음 |
| 전체 확률·entropy·disagreement 등 원시 배열 | 기본 전송 제외. 별도 승인된 검토 목적에 한해 이미 있는 배열만 선택 | 직접 다운로드 API 없음 |
| 근육 측정·QC·계산 provenance | 검증된 schema로 저장 | 허용된 JSON/표/리포트 |
| 표시용 GLB·구조 이름/색상 | 허용된 표시 geometry로 저장 | 권한 확인 후 viewer에 전달 |
| 선택한 대표 Overlay | 픽셀 식별정보까지 검사한 표시 사본, artifact별 승인 후 전송 | 승인된 snapshot만 |
| 모든 slice/다방향 표시용 volume | 기본 미전송 | 별도 기관 정책/기능을 선택할 때만 |
| 전체 원본 header·로컬 경로·모델 가중치·개인키·로그 | 전송 제외 | 없음 |
| 환자/검사 식별 | 아래 8.4의 명시적 허용 필드 | 기관/대상 권한에 따라 최소 정보 |

MRI Water만으로 지방침윤율이 측정됐다고 표시하지 않는다. 현재 출력에서 없는 값은 null + 미측정/미지원 사유를 유지한다. CT HU fat-range와 MRI 구성 지표, X-ray 투영 면적을 동일 지표로 비교하지 않는다. cm²와 cm³, Raw와 PP500/강화 후보, 계산법과 촬영 범위를 결과별로 보존한다.

기본 게시 allowlist는 Mask·측정/QC 요약·표시 GLB·승인 대표 영상이다. 결과 폴더를 통째로 업로드하지 않는다. 현재 CT가 저장하지 않는 전체 native 확률 배열을 공유 때문에 재생성/재추론하지 않는다. 원시 배열 부재는 정상 상태이며 측정/QC 게시 실패 사유가 아니다.

### 8.2 보호 저장소와 키

- 로컬 기존 결과 키/기관 복구 키는 그대로 유지한다. 동기화 때 전체 저장소 키 또는 DPAPI blob을 보내지 않는다.
- 게시할 mask를 승인된 Desktop backend가 메모리/스트림에서 읽고, **artifact 전송 attempt별 임의 DEK**와 검증된 AEAD 구현으로 재암호화한다. 서버 전용 수신 공개키/KMS wrapping 정책으로 DEK를 감싼다. AAD에 orgId/origin/revision/artifactId/attemptId/schema를 결합한다. 로컬 저장소 키는 재사용하지 않는다.
- 대형 artifact는 검증된 streaming AEAD 형식을 사용한다. 재개 전송의 chunk 순서·전체 길이·최종 인증과 nonce 재사용 방지를 검사하며, 자체 암호 프로토콜을 새로 만들지 않는다. 같은 attempt의 재개는 저장된 암호문을 그대로 재전송한다. 재암호화가 필요하면 새 attemptId/DEK/nonce를 만들되 **결과 revision과 원문 artifact identity는 바꾸지 않는다**(§9.2).
- Mask/확률 artifact는 별도 private bucket 또는 강제 prefix/IAM 경계에 둔다. viewer 서비스 계정에는 decrypt 권한을 주지 않는다. 필요한 내부 QC/derivative worker만 해당 revision에 한정해 읽는다.
- 모델 key issuer, license issuer, 결과 암호화/KMS 키, 계정 OIDC 서명키는 용도와 권한을 분리한다. 처음에는 같은 서버에 서비스가 있어도 계정/volume/권한을 섞지 않는다.
- 평문 mask 임시파일·public URL·CDN·브라우저 cache·API 응답·진단 bundle에 넣지 않는다. 서버 복구 백업에서도 암호문과 KMS 복구 권한을 분리한다.
- 업로드 endpoint의 허용 kind/크기/hash를 검증한다. renderer가 임의 경로를 읽어서 업로드하게 하는 IPC를 만들지 않는다. 등록된 result revision만 backend가 추출한다.

### 8.3 렌더링과 자산 노출의 한계

브라우저/태블릿에서 직접 회전하는 GLB를 보내면 사용자는 그 geometry를 확보할 수 있다. 이를 바탕으로 구조 모양을 근사할 수도 있다. **Native Mask 파일을 안 보내는 것과 형태 정보의 추출을 원천 방지하는 것은 다르다.** 화면 캡처도 완전히 막을 수 없다.

기본안은 사용자가 기존에 허용한 표시용 3D 공유를 따른다. mask·확률·전체 해상도 labelmap은 서버 내부에 두고 허용된 표시 geometry만 제공한다. geometry 자체도 외부에 줄 수 없는 기관은 별도 **서버 렌더링** 모드(이미지/영상 스트림, 서버 GPU·지연·비용 검증)를 선택해야 한다. 이를 기본안과 동등한 무료 구현으로 가정하지 않는다.

원본을 전송하지 않는 조건에서는 서버가 임의 위치의 원본 배경 Overlay를 새로 만들 수 없다. V1은 게시한 대표 Overlay만 제공한다. 전체 slice 스크롤이 필요하면 de-identified 표시용 이미지/volume을 따로 전송하거나 기관 내부 원본 서버와 연결해야 한다. 변환 영상도 영상 데이터이며 “원본 파일이 아니니 환자 데이터가 아니다”라고 취급하지 않는다.

### 8.4 환자/검사 연결

서버는 org-scoped `cloudPatientId`, `studyId`, `resultId`를 사용한다. 파일명·개인 이름·날짜만으로 서로 다른 PC의 환자를 합치지 않는다. DICOM UID/환자번호/기관은 허용 필드 정책과 사용자 확인을 거쳐 연결한다. 기본 게시에는 임의 case label을 사용하며, 실제 환자 연속 추적은 기관이 승인한 식별 매핑 또는 기존 서버 환자 선택으로 수행한다.

식별 정보를 제거해도 geometry/검사 시각 등 파생 데이터는 민감하게 취급한다. 서버의 환자 연결 변경은 결과를 덮어쓰지 않고 감사되는 연결 revision으로 기록한다. 다른 기관 사이에 같은 patientId가 있어도 합치지 않는다.

### 8.5 대표 영상의 게시 승인

header/JSON 필드를 제외해도 영상 픽셀에 찍힌 이름·번호는 남을 수 있다. 대표 영상도 기관의 식별정보 정책에 포함한다. V1은 게시할 **최종 표시 사본**을 사용자에게 보여주고, 허용되지 않은 식별 영역은 픽셀 자체에서 비가역 제거한 뒤 다시 확인하게 한다. 원본·분석 Mask·측정값은 바꾸지 않는다. CSS 가림, OCR 성공, `BurnedInAnnotation=NO`만으로 확인을 대체하지 않는다. [DICOM PS3.15 E.3.1](https://dicom.nema.org/medical/dicom/current/output/chtml/part15/sect_E.3.html)

artifact별 `privacyReview`에는 정책 버전, 확인한 최종 원문 hash, 허용 식별정보 범위, 제거 여부, 확인자/시각을 기록한다. 서버는 게시자 권한과 승인을 검증하며 새 파일/hash·정책 변경 시 다시 승인받는다. 이것은 임상 QC 승인과 다른 절차다. 오프라인 검토는 로컬 임시 기록으로 남기고 로그인 후 게시자가 확인한다. 미확인 영상은 기본 제외하며 승인된 나머지 결과만 게시할 수 있다. 기관이 식별정보 유지를 허용해도 그 범위/승인을 명시한다.

## 9. 동기화: 분석 완료와 서버 게시를 분리

```text
로컬 분석 → 측정·Overlay 사용 가능 → 3D 준비(독립)
              ↓ 사용자가 게시 선택
        로컬 outbox → 로그인/권한 확인 → upload session
              → 암호화 artifact 전송 → server 검증 → commit
              → 측정/QC 공개 → 3D 준비되면 별도 첨부 commit
```

### 9.1 결과 계약

결과의 의미상 내용과 암호화 전송 정보를 다음처럼 분리한다.

| 계약 | 고정 내용/역할 |
| --- | --- |
| Origin | `originStoreId`, `originResultId`, `analysisRevision`. PC 교체/복구/재게시에도 고정 |
| Analysis content | solution/workflow/schema, modality/route, model/recipe/runtime digest, variant, native geometry/단위/label 사전, 측정·기계 QC·촬영 범위·좌우 신뢰, 필수 Mask 원문 hash |
| Publication identity | `(orgId, originStoreId, originResultId, analysisRevision)` unique, 서버 `resultId`와 매핑. 첫 성공 commit의 `workspaceId`에 고정 |
| Upload attempt | `attemptId`, `uploaderInstallationId`, actor·고정된 대상 workspace, artifactId·원문/암호문 hash·size·암호화 metadata·expiry·전송 상태 |
| Display attachment | 원래 origin/revision/Mask digest에 묶인 GLB·승인 Overlay. 늦은 준비/새 표시 사본은 별도 attachment generation과 CAS |

`contentDigest`는 schema가 지정한 고정 Analysis content를 canonical JSON으로 직렬화한 SHA-256이다. 키/배열 순서·유한 숫자·문자열 인코딩 규칙은 공통 fixture로 고정한다. uploader, attemptId, 암호문 hash, nonce, wrapped DEK, 전송 시각, mesh 준비 상태, 환자 연결/임상 검토 상태는 제외한다. 늦은 3D와 게시 영상 승인 변경으로 기존 분석 내용의 digest를 바꾸지 않는다. 원문 Mask hash는 private contract에 보관한다.

originStoreId는 기존 결과 저장소 ID를 보존하고 originResultId는 분석 run의 결과 ID를 보존한다. analysisRevision은 확정된 variant snapshot마다 한 번 발급·저장하는 불변 ID이며 UI 선택/재전송 때 다시 발급하지 않는다. 기존 결과는 별도 migration sidecar에서 안정 매핑하고 published.json을 덮어쓰지 않는다. 최초 저장소는 활성 장비의 기관/소유 증명으로 서버에 등록하고, legacy 저장소는 기관 관리자가 소속을 승인한다. 복구한 PC가 origin을 임의 주장할 수 없게 서버 원장의 기관 소유 및 승인된 origin→현재 uploader 연결을 검사한다. 기관 내 PC 이전은 이 연결만 추가하며, 다른 기관으로의 이관은 별도 승인 절차다.

공개 viewer projection에는 내부 경로·키 봉투·private mask 위치·worker log를 제외한다. 모델 digest 등 검토용 provenance는 권한에 맞게 제공하되 가중치를 포함하지 않는다. 클라이언트가 보낸 `publisherUserId`를 신뢰하지 않고 서버 세션에서 게시자를 결정한다. 생성 시 로그인하지 않았다면 creator는 installation/local operator로 기록하며 마지막 로그인 사용자를 생성자로 꾸미지 않는다.

### 9.2 Outbox 상태

`queued → preparing → uploading → verifying → published`; 보조 상태는 `waiting_network`, `needs_login`, `needs_permission`, `quota_blocked`, `failed`, `cancelled`다. 상태는 로컬에 원자적으로 저장해 재시작 후 복구한다. 데이터 사본이나 manifest가 없어졌으면 실패를 명확히 표시하며 빈 결과를 업로드 완료로 만들지 않는다.

- 결과 중복 방지 key는 §9.1 Publication identity다. 같은 key/같은 contentDigest이고 게시 대상 workspace도 같을 때만, 현재 사용자에게 해당 결과 반환 권한이 있는지 다시 검사한 뒤 기존 결과를 반환한다. 다른 contentDigest는 409다. 현재 게시 PC나 랜덤 암호화 값으로 결과를 새로 만들지 않는다.
- 대상 workspace는 attempt 생성 시 고정한다. begin·상태 조회·complete·중복 결과 반환·후속 attachment에서 요청/session/기존 결과의 workspace 일치를 검사한다. 이미 게시된 결과를 다른 workspace로 요청하면 `409 PUBLICATION_TARGET_MISMATCH`로 거부하고 자동 이동·공유·복제를 하지 않는다. 권한이 없는 기존 workspace명·resultId·환자 정보는 오류 응답에 포함하지 않는다. 요청 대상 자체의 접근권이 없으면 먼저 403으로 거부한다. workspace는 contentDigest나 중복 방지 key에 추가하지 않는다. 그렇게 하면 같은 결과를 새 대상으로 재게시해 중복/삭제 차단을 우회할 수 있기 때문이다. 이동·공유는 감사와 별도 권한 검사가 필요한 후속 기능이며 V1 게시 API로 수행하지 않는다.
- 전송 재시도 key는 별도 `attemptId`다. 같은 attempt/동일 전송 manifest는 같은 session을 재사용하고 다른 암호화 metadata는 409다. 만료/취소/암호문 사본 손실은 새 attempt로 준비한다. 응답 유실 후 먼저 서버 상태를 조회하고, 이미 게시됐다면 권한을 재검사한 뒤 같은 결과를 반환한다.
- 같은 결과를 여러 attempt가 동시에 완료하면 transaction/unique/CAS로 하나만 공개하며 첫 성공 commit의 workspace를 함께 고정한다. 뒤늦은 동일 내용·동일 workspace는 기존 결과로 수렴하고 staging만 정리하며 채택된 암호문을 덮어쓰지 않는다. 서로 다른 workspace가 경합하면 한쪽만 성공하고 다른 쪽은 대상 불일치로 거부한다. tombstone은 begin과 commit 모두에서 확인하며 삭제로 workspace 귀속을 초기화하지 않는다. 실제 분석 내용 변경은 새 analysisRevision이 필요하다.
- 장기 업로드는 multipart/resume을 지원한다. bytes/part hash/완료 hash/manifest를 확인한 뒤 commit한다. 부분 업로드는 원격 최근 결과에 노출하지 않는다.
- 로그인/role/org/설치 binding은 begin과 commit에서 다시 검증한다. 취소·권한 회수 후 발급된 URL로 bytes가 도착해도 commit을 허용하지 않는다. orphan staging object는 정책 TTL(기본 24시간) 후 제거한다.
- schema가 정한 필수 artifact가 완비돼야 게시한다. 클라이언트가 Mask를 optional로 바꿀 수 없다. 서버 내부 검증 worker가 암호 인증·원문 hash·형식/geometry/label schema를 확인한 뒤 공개한다. 3D가 아직 없으면 `meshState=pending`으로 측정/QC 게시를 허용하고 나중에 표시 attachment를 CAS로 추가한다. 전체 확률 배열은 필수 artifact가 아니다.
- Raw, PP500, 강화 후보/재분석은 별도 analysis revision이며 서로 덮어쓰지 않는다. UI에서 variant 선택이 바뀌었다고 서버의 기존 결과가 교체되지 않는다.
- 추가 3D는 원래 revision/model/mask digest에 결합한다. 다른 revision의 GLB가 늦게 도착하면 거부한다. 서버가 원본 없이 새 segmentation/지표를 만들어 채우지 않는다.
- 추가 GLB/Overlay는 이미 공개된 core를 재게시하지 않고 별도 attachment 요청으로 처리한다. attachment의 원문 identity/generation과 암호화 attempt를 동일하게 분리하며, 현재 attachment revision의 CAS와 영상 승인 검사를 거친다. 단순 재암호화는 표시 사본 generation을 올리지 않는다.
- 네트워크 재시도는 backoff+jitter, 크기/서명/권한 오류는 자동 무한 재시도하지 않는다. 실패 case와 정상 case를 격리한다.
- GPU/CPU 분석 우선. 기본 전송 동시성 1, 패키지 설치 동시성 1. 동기화 때문에 slice scroll/Overlay/추론 메모리를 점유하지 않게 스트리밍·bounded buffers를 사용한다.
- 로컬 삭제와 서버 삭제는 별도 명령이다. 양방향 파일 동기화처럼 한쪽 삭제를 자동 전파하지 않는다. 게시 취소는 아직 공개되지 않은 staging만 취소한다.

## 10. 원격 열람·태블릿

Web/태블릿은 로그인 → 기관/workspace 선택 → 결과 목록 → 결과 열람/비교다. Desktop의 구매 솔루션 선택 화면을 그대로 복제하지 않는다. 동글을 태블릿에 꽂지 않아도 계정의 데이터 접근권으로 결과를 읽는다.

- 결과별 `solutionId + resultSchemaVersion + viewerAdapter`로 화면을 결정한다. 지원하지 않는 새 결과는 앱 업데이트 필요를 표시하고 잘못된 단위/label로 열지 않는다.
- 측정·QC, 3D, 게시된 Overlay 범위, 촬영 범위·좌우 신뢰도를 표시한다. 최대 3개 호환 결과 비교, X-ray Lt/AP/Rt 그룹, 누락 view를 유지한다.
- 각 비교 결과는 자체 geometry와 독립 회전을 사용한다. 다른 modality/지표 간 무의미한 수치 비교를 자동 허용하지 않는다.
- 비교 시작은 `quantity + unit + ontology + measurementMethod + coverage`가 검증된 호환 계약을 만족해야 한다. V1은 명시적으로 같은 계약만 허용하고 모르는 필드는 거부한다. 허용 mapping 없이 이름/단위만 같다는 이유로 다른 계산법을 합치지 않는다. 같은 modality여도 다른 지표면 거부하고, modality만 다른 경우라도 검증된 공통 계약이 있다면 허용할 수 있다. 단순 나란히 열람은 수치 비교와 구분한다.
- measurementMethod에는 측정 ROI/촬영 방향 등 수치의 의미를 바꾸는 조건을 포함한다. X-ray 그룹 비교도 Lt/AP/Rt를 대응시켜 같은 방향끼리 비교하며 AP 면적을 LAT 면적과 같은 값으로 합치지 않는다. 촬영 범위 정보가 없으면 동일 coverage로 추정하지 않는다.
- Desktop/remote 제품 종류는 현재 페이지와 별개로 유지한다. 로그인 성공/취소/만료 복귀 경로는 그 제품의 허용 경로로만 제한한다. Desktop 안의 서버 결과 조회·재로그인은 Desktop 메뉴를 유지하고 같은 조회 화면으로 복귀한다. Web 로그인 후 Desktop 분석 홈으로 돌아가지 않으며 Web build 자체에 분석 경로/코드를 넣지 않는다.
- 태블릿은 터치 선택/회전/확대와 명시적 구조 상세를 제공한다. hover/우클릭만으로 핵심 정보를 보게 하지 않는다. 3D 부담이 크면 감소된 표시 mesh를 사용하되 측정은 native 결과를 유지한다.
- Web의 base preview는 mask를 필요로 하지 않아야 한다. local renderer를 재사용하되 `exmoDesktop` IPC/입력 picker/model files를 포함하지 않는다.
- 서버는 목록·manifest·artifact·검색·비교·삭제 각각에서 org membership/workspace ACL/object 소속을 검사한다. UUID를 알거나 URL을 바꿔도 다른 기관 자료를 읽을 수 없어야 한다. [OWASP API1](https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/)
- 기본은 online-only 원격 열람이며 민감한 영상/GLB의 영구 service-worker cache는 끈다. logout 시 세션과 메모리/앱 cache를 정리한다. 오프라인 태블릿 결과 저장은 원격 회수 불가와 장치 암호화/MDM을 포함하는 별도 승인 기능이다.
- 개인 간 공개 링크는 기본 제공하지 않는다. 외부 협진 공유는 기관 승인, 대상 사용자, 만료, 조회 감사가 있는 별도 기능으로 추가한다.

## 11. 서버 구성·API·데이터 모델

### 11.1 첫 배포 단위

처음부터 상품별 서버를 나누지 않는다. OIDC 공급자 + 모듈형 control/results API + DB + private object store + 제한된 background worker로 시작한다. license signing과 결과 decrypt 권한은 별도 프로세스/서비스 계정으로 격리한다. 첫 서버 한 대에 배치해도 권한/백업/운영 경계는 유지한다.

```text
Desktop ── device proof ── License API / signing authority
   │                           │ 계약·키 배정·entitlement
   ├── OIDC ── Identity provider│
   └── account session ── Result API ── metadata DB / private objects
                                      │
Web / tablet ── account session ── Viewer API ── 허용된 결과 projection
                                      │
                        private mask worker (별도 decrypt 권한)
```

라이선스 요청에는 환자 영상·환자번호·mask가 없다. 결과 API에는 계약 발급 개인키·모델 DEK가 없다. 운영 로그에는 토큰, 업로드 URL, mask, 파일 경로/환자 이름을 기본 기록하지 않는다. 중앙 운영 지표는 설치/인증/전송 지연·오류 code·correlationId를 사용한다.

### 11.2 서버 원장

| 엔터티 | 핵심 키/제약 |
| --- | --- |
| Organization / Workspace | orgId, workspaceId, org 내 scope. 기본 org당 workspace 1개 가능 |
| User / Membership | `(issuer, subject)` unique; org membership 상태·역할; workspace 접근 |
| Device / Dongle / Assignment | installationId, profile, 설치/모델 수신키 지문, attested key 지문, orgId, 상태; 동글당 활성 assignment 1개 |
| License / Entitlement | 장비 배정, solutionId, 기간·상태·capability·revision. bundle 발급 출처 |
| SolutionRelease / Package | solution/workflow/version, signer/profile, digest, dependencies, 최소 앱/worker/schema |
| Patient / Study mapping | org-scoped ID, 승인된 식별 필드/연결 revision; 기관 간 unique 공유 금지 |
| OriginBinding | originStoreId·org 소유, 승인된 uploaderInstallationId, 이전/복구 승인 이력. 클라이언트 주장만으로 연결 금지 |
| ResultRevision / Artifact | Publication identity unique, 첫 성공 commit에 고정된 workspaceId, contentDigest, schema/recipe/mask/표시 attachment 연결, state, bytes/hash |
| UploadSession | attemptId unique, origin/revision, org, 고정된 대상 workspaceId, user, 현재 uploader, 전송 manifest hash, expiry, parts, commit 상태 |
| Audit / Tombstone | 실행·게시·열람·권한·삭제·장비 이전 추적. 삭제 이후 오래된 outbox 재업로드 차단 |

v2 SQLite 원장을 단순 JSON field 추가로 즉시 다기관 서버로 쓰지 않는다. 운영 DB는 transaction/unique/FK/backup migration을 갖춘 PostgreSQL을 기본안으로 한다. 기존 발급 원장을 백업·dry-run 변환하고 `oldLicenseId → newAssignmentId` 매핑을 남긴다. DB 종류 확정과 실제 서버 성능 측정은 구현 환경 단계다.

### 11.3 주요 API 계약

| 경로(계획) | 호출자/검사 | 의미 |
| --- | --- | --- |
| `GET /v1/me`, `/v1/workspaces` | 사용자 access token | 계정·기관/role. 로컬 분석 권한을 반환하지 않음 |
| `POST /v3/device-enrollments` | 관리자 + PC/key proof | 장비 등록 요청; 계약 없이 자동 승인 안 함 |
| `POST /v3/challenges`, `/v3/leases` | PC/동글 proof, nonce | 계정 세션과 독립된 license 갱신 |
| `GET /v1/solutions`, `/v1/packages/{digest}` | catalog 및 설치 권한 | signed catalog/manifest, profile·호환성 검사 |
| `POST /v1/install-authorizations` | 관리 권한 + device binding | 해당 패키지 다운로드·봉투 발급; 모델 실행 grant 아님 |
| `POST /v1/workspaces/{id}/uploads` | 게시자 membership + 현재 uploader proof + 승인 origin 연결 + 서명 content/전송 digest + 요청/기존 workspace 일치 | Publication identity와 attemptId를 각각 검사해 session 발급/허가된 기존 결과 반환; 다른 대상은 409 |
| `GET /v1/uploads/{id}` | 동일 actor 또는 명시적 인수 권한, org/장비/origin·session/결과 workspace 검증 | 응답 유실 후 session/commit 상태 조회; 다른 대상으로 완료된 결과는 반환하지 않음 |
| `POST /v1/uploads/{id}/complete` | actor/workspace/장비/origin 재확인, 대상 일치, tombstone, 암호/원문 검증, 영상 승인 | transaction으로 결과·workspace 귀속 공개; 동일 내용·동일 대상의 중복 complete만 기존 결과 반환 |
| `POST /v1/results/{id}/revisions/{rev}/artifacts` | 기존 결과 workspace의 게시/현재 장비/origin 권한, 대상 일치, 삭제 확인, 원문/recipe/영상 승인, CAS | attachment 원문과 전송 attempt를 분리해 늦은 GLB/승인 Overlay 첨부; workspace 변경 불가 |
| `GET /v1/workspaces/{id}/results` | membership/ACL, pagination | 최소 정보 목록, field 필터 |
| `GET /v1/results/{id}/revisions/{rev}` | object-level ACL | 공개 manifest/측정/QC |
| `GET /v1/results/{id}/artifacts/{artifact}` | allowlisted viewer kind + ACL | GLB/Overlay/report만. mask kind는 공개 라우트 없음 |
| `POST /v1/results/{id}/delete-requests` | data admin + 확인 + revision | 보존 정책에 따른 삭제, tombstone |

일반 사용자 API로 계약/서명키를 변경하지 않는다. 관리자 API는 별도 role/MFA/감사를 적용하고 내부 관리망 또는 제한된 운영 경로로 제공한다. idempotency key, If-Match revision, requestId를 공통 사용한다. 401은 재로그인, 403은 권한 확인, 409는 revision 충돌, 413은 크기 제한, 429/503은 retry-after를 반환한다. 내부 traceback 대신 기존 code/stage/action/reference 진단 형식을 확장한다.

기존 결과 게시는 현재 유효한 분석 entitlement를 요구하지 않는다. 계정의 게시 권한, 기관/장비 신원, 결과 provenance와 저장 계약을 검사한다. 따라서 분석 상품 만료만으로 과거 결과 게시를 막지 않지만, 분실/회수된 장비의 무인 전송은 차단하고 관리자가 데이터 이관 절차로 처리한다.

signed URL은 필요할 때 **업로드 staging에 한정**하고 짧은 수명·고정 object·크기/종류 제약을 둔다. 민감한 viewer 다운로드는 기본 인증 proxy를 사용한다. 향후 성능 때문에 URL을 쓰면 URL 만료 전 회수를 즉시 보장할 수 없다는 점을 정책에 반영한다. 임의 URL을 서버가 가져오게 하는 SSRF 경로를 만들지 않는다.

### 11.4 보존·삭제·복구

분석 license 만료는 결과 삭제 이벤트가 아니다. cloud storage 계약 만료도 즉시 삭제가 아니라 기관에 고지된 읽기/내보내기/보존 절차를 따른다. 구체 기간과 백업 만료는 계약 설정이며 무기한 보관으로 몰래 확정하지 않는다.

삭제는 org/권한 재검증 → 삭제 요청/승인 기록 → 결과 접근 차단/tombstone → object/파생본/색인 정리 → 백업 정책의 만료 처리 순서다. tombstone은 현재 게시 PC/attempt가 아니라 org와 안정된 origin/revision에 결합한다. 결과 전체 삭제인지 특정 revision 삭제인지 범위를 기록하고, 오래된 outbox·새 PC 복구·새 암호화 attempt·늦은 GLB 모두 같은 삭제 범위를 검사한다. 삭제 해제는 별도 관리자 복구 절차이며 재게시로 자동 해제하지 않는다. 서버 삭제는 로컬 원본을 건드리지 않는다. 계정 탈퇴/동글 분실은 기관 데이터 삭제로 연결하지 않는다.

DB·object store·KMS/key escrow의 복구를 함께 시험한다. RPO/RTO 수치는 서버 용량·계약 확인 후 정하며, 키/원장을 잃어도 데이터가 복구된다고 보장하지 않는다.

## 12. 내부 개발용·고객용

- 공통 소스로 같은 기능을 개발하고 profile로 서명 authority·장비 증명·서버·데이터 위치를 분리한다.
- 고객은 PC+실물 YubiKey, 내부는 승인된 PC 키로 운영한다. 내부도 solution entitlement 목록을 받아 상품 제한·미설치·만료 UI를 실제로 시험할 수 있게 한다.
- 내부 issuer/가짜 동글/개발 토큰을 고객 앱에 넣지 않는다. 고객 installer의 `Admin` 체크박스로 동글 우회권을 만들지 않는다.
- source development의 fixture catalog·가짜 서버는 개발에서만 사용한다. 고객 패키지에 fixture·관리 CLI·server private key·테스트 데이터가 들어가면 build 실패다.
- 서버 환경은 production/staging/internal의 기관·계정·issuer·bucket을 분리한다. 실사용 환자 결과를 개발 서버로 자동 전송하지 않는다.

## 13. 기존 자료와 호환·전환

1. 새 필드는 읽기 adapter에서 기본값을 적용한다. legacy `analysis=ct/mri/xray`는 승인된 고정 매핑으로 solutionId를 보완하되 원본 published.json을 일괄 덮어쓰지 않는다.
2. legacy 결과는 cloud org/user를 추측해 자동 업로드하지 않는다. 기관 관리자가 로컬 저장소의 소속을 확인한 뒤 게시 후보로 편입한다.
3. v2 `ap`만 또는 `lat`만 허용한 계약을 v3 완전한 X-ray 상품으로 자동 승격하지 않는다. 기존 capability 범위를 보존하는 legacy entitlement로 이전하거나 운영자 승인 후 bundle을 발급한다.
4. v2 client/lease/model-run은 전환 기간 별도 경로로 지원한다. v3 상품만 부분 회수한 뒤 v2가 계속 전체 engine 권한을 받는 downgrade 경로를 막아야 한다. 변환된 계약의 v2 발급을 끊고 이미 발급된 lease의 만료/이행 기간을 관리한다.
5. 기존 전체 payload와 새 선택형 payload는 서로 다른 schema로 읽는다. 새 verifier가 구 payload를 명시적으로 지원하며, 구 verifier에 새 payload를 억지로 읽히게 하지 않는다.
6. installer/reader rollback은 구 결과를 손상시키면 안 된다. 계정 캐시/동기화 DB는 별도 경로에 추가한다. 앱 제거/상품 제거/계정 logout을 결과 키 삭제와 연결하지 않는다.

## 14. 반드시 통과해야 하는 설계 검토 항목

| 위험 | 설계상 대응 | 검증 항목 |
| --- | --- | --- |
| 상품 버튼만 숨겨 권한 우회 | main+worker의 solution/workflow/digest 검사 | 미구매 IPC 직접 호출 및 job 변조 거부 |
| MRI 만료가 CT를 막음 | 상품별 기간/상태, 별도 readiness | 혼합 유효/만료 3개 상품 검사 |
| 설치 선택 후 공통 reader/CT CUDA 손상 | 명시적 dependency graph | CT만/MRI만/X-ray만/복수 설치와 제거 검사 |
| 로그인 장애가 로컬 분석을 중단 | device lease와 계정 분리 | 로그아웃/서버 장애 중 유효 분석 완료 |
| 다른 사용자 로그인 시 잘못된 기관 전송 | immutable org/workspace outbox + commit 검사 | 계정/기관 전환 중 업로드 격리 |
| native mask를 GLB처럼 공개 | 비공개 저장소, viewer kind allowlist | Web 네트워크·CDN·URL·로그에 mask 부재 |
| 원본 없이 원격 Overlay 기능을 약속 | 게시 artifact capability를 표시 | slice stack 없는 결과의 임의 slice 요청 거부 |
| 3D 지연이 서버 측정 게시를 막음 | 필수 결과/선택 3D generation 분리 | delayed/failed GLB와 metrics 게시 검사 |
| 이전 variant/오래된 전송이 새 결과 덮어씀 | immutable revision + CAS + idempotency | 병렬 게시·재시도·Raw 복귀·삭제 후 전송 |
| 과거 결과가 license 만료/모델 삭제로 잠김 | reader 독립, data ACL 별도 | 만료/동글 없음/모델 미설치로 과거 결과 열기 |
| 공유 PC/동글이 사람 인증으로 오인 | 설치·OS·계정 신원 구분 | 사용자 교체·logout·로컬/원격 권한 경계 검사 |
| 결과 저장/Mask 보호가 “절대 추출 방지”로 과장 | geometry 노출·동일 사용자 권한 한계 명시 | 제품 설명/보안 문서 검토 |

검증 가능한 출시 조건과 순서는 [구현 계획](EXMO_SOLUTION_PRODUCTIZATION_PLAN.md)에 있다. 정책 가정은 위 표에 명시했고, 실제 서버·실물 동글·서명 설치본의 통합 검증 전에는 제품 출시 완료로 표시하지 않는다.

2026-10-17 재검토의 최초 7건과 후속 5건을 설계와 모형에 반영했다. [리뷰의 반영 기록](EXMO_SOLUTION_PRODUCTIZATION_REVIEW.md)에서 수정 범위·검증 증거를 확인한다. 서버 계약은 실제 구현/통합 검증을 마친 것이 아니다.

# EXMO 내부 개발 라이선스 운영과 검증

작성일: 2026-10-15 · Windows x64 · Node 22.14.0 · Electron 44.4.5

**내부용 Desktop은 EXMO 서버가 승인한 Windows 설치 키로 인증하며 YubiKey가 필요 없다.** Windows 관리자 권한으로 설치한다고 분석 권한이 생기지 않는다. 서버 관리자가 장비·엔진·만료일을 승인하고, 앱은 온라인 활성화 후 서명된 권한의 유효기간 안에서 동작한다.

2026-10-16 갱신: 전체 CT/MRI/X-ray/분류 모델 암호화, 결과 파일 보호·복구, 고객 PC+동글 이중 키, 오프라인 payload와 서버 운영 CLI를 연결했다. 최신 절차와 검증 범위는 [제품 보안 runbook](EXMO_PRODUCT_SECURITY_RUNBOOK.md)을 따른다. 아래 MRI 1차 실행 기록은 당시 검증 이력이다. 내부 설치본을 고객 출시본으로 취급하지 않는다.

## 실행본 구분

| 실행본 | 인증 | 데이터 위치 | 배포 |
| --- | --- | --- | --- |
| 저장소에서 `npm run desktop` | 기존 소스 개발 실행 유지 | 기존 EXMO Atlas 저장소 | 제품 설치본으로 패키징 불가 |
| EXMO Atlas Internal | 온라인 서버 승인 + 매 분석 Windows 설치 키 증명 | `%APPDATA%/EXMO Atlas Internal` | 명시적인 내부용 빌드 명령 |
| 고객용 EXMO Atlas | 별도 발급 키 + 고객 profile + PC + YubiKey | 기존 고객용 경로 유지 예정 | 현재 출시 차단 |

내부용 app ID는 `com.exmo.atlas.internal`이다. 기존 앱의 결과·환경 설정을 덮어쓰지 않는다. 모델 런타임은 내부용 `engine.json`의 `root` 또는 기존 `EXMO_ENGINE_ROOT`로 연결한다. 이 설정은 모델 경로이며 라이선스를 끄지 않는다.

예전 NAS 이관 ZIP의 설치 스크립트는 기존 앱 경로를 사용한다. 새 Internal EXE만 그 ZIP에 교체하지 않는다. 이번에는 기존 ZIP을 재생성하거나 모델 묶음을 옮기지 않았고, 내부용 앱에는 이미 준비된 모델 경로를 연결한다.

서버 공개키·주소·profile은 패키지 안의 `desktop/security/build.json`에 고정된다. 승인 파일이나 환경변수에 `admin`, `skipLicense` 등을 넣어도 인증을 해제할 수 없다. 패키지에 정책 파일이 없거나 손상되면 시작을 거부한다. 소스 코드와 실행파일 자체를 수정하는 공격까지 이 설정 검사만으로 막는다는 뜻은 아니다.

## 등록과 승인

1. 내부용 앱이 현재 Windows 사용자 아래에 P-256 설치 키를 생성한다. Microsoft Software Key Storage Provider의 내보내기 금지 정책을 사용한다. 개인키 PEM을 생성하거나 설치 파일에 넣지 않는다.
2. 상단 **내부 개발용 · 승인 필요**에서 **등록 요청 저장**을 선택한다. 설치 ID·공개키·지문 JSON을 EXMO 운영자에게 전달한다. 환자 정보는 포함하지 않는다.
3. 운영자가 발급 서버의 로컬 CLI로 장비 소유자, 허용 엔진, 명시적인 만료일을 승인하고 공개 승인 파일을 반환한다.
4. 앱에서 **승인 파일 적용**을 선택한다. 현재 PC 키와 파일을 대조한 뒤 서버에 새 challenge 서명을 제출한다. 서버가 승인해야 활성화되며 파일 복사만으로 권한이 생기지 않는다.
5. 앱 시작·절전 복귀와 주기적 갱신에서 재확인한다. **지금 갱신**으로 수동 재확인할 수도 있다.

개발 서버에서 Desktop을 자동 실행해도 동일한 Windows 사용자 프로필과 승인된 설치 키를 사용한다. 다른 계정·새 PC·키 손상 시 새 장비로 등록한다. 실행 계정을 Administrator/SYSTEM으로 바꿔 기존 키를 찾도록 우회하지 않는다.

현재 관리자는 **발급 서버에 접근할 수 있는 EXMO 운영자**다. 고객 PC의 Windows 관리자, 설치 체크박스, 앱 내부 공용 비밀번호를 관리자 자격으로 취급하지 않는다. 별도 웹 관리자 계정·SSO 화면은 아직 없다.

## 서버 준비와 빌드

아래는 저장소 루트 PowerShell의 로컬 재현 예시다. 새 폴더를 사용하며 기존 발급 키·원장·파일을 덮어쓰지 않는다. v1 PoC 원장을 v2 profile 규약으로 자동 변환하지 않는다. 새 검증 authority를 만들고 재등록한다.

```powershell
New-Item -ItemType Directory -Force work/security-internal | Out-Null
node scripts/security/license-server.cjs init work/security-internal/authority internal
node scripts/security/internal-admin.cjs build-config work/security-internal/authority http://127.0.0.1:43127 work/security-internal/build-public.json --loopback-test
node scripts/security/license-server.cjs serve work/security-internal/authority 43127
```

서버를 유지하고 다른 터미널에서 빌드한다.

```powershell
npm run desktop:pack:internal -- work/security-internal/build-public.json
npm run desktop:dist:internal -- work/security-internal/build-public.json
```

실행 폴더는 `release/internal/win-unpacked`, NSIS 설치 파일은 `release/internal/EXMO-Atlas-Internal-Setup-0.1.24.exe`다. `--loopback-test`로 만든 설치본은 해당 PC의 시험 서버에 연결한다. 다른 개발 PC에 전달하려면 실제 EXMO 내부 HTTPS 주소로 공개 빌드 설정을 만들고 재빌드한다. HTTPS 주소에는 `--loopback-test`가 필요 없다. 서버 주소를 사용자가 입력하는 활성화 파일로 바꾸지 않는다.

`desktop:pack`과 `desktop:dist`는 고객용 경로이며 현재 오류로 종료된다. 직접 `electron-builder`를 실행해도 `beforePack`에서 내부용 정책과 app ID를 확인한다. 생성 후 실제 ASAR의 정책·리소스와 서버/모의 개인키의 제외를 검사한다. 내부 NSIS는 현재 코드 서명되지 않았으며 관리자 권한을 강제하지 않는 사용자 단위 설치다.

## EXMO 운영자 명령

만료 시각은 UTC로 명시한다. 아래 ID·날짜·파일 경로는 예시다. 장비 소유자를 운영자가 확인한 뒤 승인한다.

```powershell
node scripts/security/internal-admin.cjs approve work/security-internal/authority C:/Requests/EXMO-internal-enrollment.json dev-workstation-01 2026-11-15T00:00:00Z ct,mri,ap,lat
node scripts/security/internal-admin.cjs activation work/security-internal/authority dev-workstation-01 C:/Requests/EXMO-internal-activation.json

node scripts/security/license-server.cjs status work/security-internal/authority dev-workstation-01 suspended
node scripts/security/license-server.cjs status work/security-internal/authority dev-workstation-01 revoked
node scripts/security/license-server.cjs status work/security-internal/authority dev-workstation-01 active
node scripts/security/internal-admin.cjs extend work/security-internal/authority dev-workstation-01 2026-12-15T00:00:00Z
```

`active`는 정지/회수를 해제하지만 만료일을 늘리지 않는다. `extend`는 만료일과 revision을 갱신하지만 정지/회수를 해제하지 않는다. 등록 키를 다른 키로 덮어쓰는 기능은 없다. 장비 교체는 이전 권한을 회수하고 새 설치를 새 라이선스 ID로 승인한다.

승인 파일은 공개 정보다. `issuer-private.pem`, `authority.sqlite`와 감사 기록은 서버에서만 보관한다. 원장·발급 키를 한 쌍으로 백업한다. 과거 원장 복원은 revision/sequence 역행을 일으킬 수 있으므로 운영 복구 절차 없이 단순 교체하지 않는다. 서버 폴더는 운영자·서비스 계정만 접근하도록 ACL을 설정한다. Windows의 Node `mode: 0600`만으로 서버 ACL 보호가 완료됐다고 보지 않는다.

## 실제 서버 배포 경계

라이선스 서버는 GPU나 환자 저장소가 필요 없는 별도 Node 프로세스다. 이번 실행기는 `127.0.0.1`에만 바인딩한다. 개발망에 올릴 때는 관리된 HTTPS reverse proxy 뒤에 두고 다음 조건을 유지한다.

- 앱에 HTTPS URL과 발급 공개키를 고정한다. 인증서 오류를 무시하지 않으며 redirect나 HTTP 자동 전환을 허용하지 않는다.
- proxy upstream은 `127.0.0.1:43127`, upstream Host도 `127.0.0.1:43127`로 둔다. Origin/Fetch 헤더 검사를 제거하지 않는다. API는 `/v1/challenge`, `/v1/lease`의 POST다.
- 개발망/VPN 접근 제한, 요청 속도 제한, TLS 갱신, 서비스 재시작, 로그 보관, 키·DB 백업을 운영 설정으로 적용한다. 원격 관리자 API는 없다.
- 내부용과 고객용의 발급 키·원장·설정을 분리한다. 고객 운영 CLI는 고정 루트에 대한 attestation 검증 후 등록한다. 실물 통합 시험은 별도다.

실제 외부 도메인에는 배포하지 않았다. HTTPS와 서명된 백업·복원은 로컬 테스트를 통과했으며 배포 설정 생성 CLI를 제공한다. 실제 서버 TLS/운영 계정/복구와 발급자 이전은 운영 환경에서 검증한다. Node 22.14.0은 이번 재현 버전이며 운영 버전 선정은 별도다.

## 권한과 분석 동작

공통 규약은 Ed25519 서명, `exmo-license-v2` issuer, `exmo-desktop-v2` audience, 서명된 `internal/customer` profile을 검사한다. 고객 바인딩에는 설치 키·동글 서명 키·동글 키 교환 키 지문이 필수이고 내부 바인딩은 설치 키를 사용한다. 모의 동글을 내부 인증 대신 끼워 넣지 않는다. 고객 클라이언트와 authority는 내부 profile을 거부한다.

challenge는 60초·1회용이며 잘못된 증명에도 소비된다. 발급 트랜잭션 안에서 계약·정지·회수 상태를 다시 읽는다. 허용과 회수 응답 모두 서명하며 revision/sequence 역행을 거부한다. 과거 허용 응답이 이미 받은 회수 상태를 풀 수 없다.

개발 정책은 갱신 300초, 유예 최대 7일이며 출시 확정값이 아니다. 실제 만료는 `min(마지막 서버 승인 + 유예, 계약 종료)`다. 장애·재시작·분석 실행으로 유예가 늘지 않는다. 재시도 간격은 30초, 네트워크/키 대기는 10초다. 시계 역행·저장 손상은 온라인 복구가 필요하다.

내부 상태는 Electron safeStorage의 Windows DPAPI로 암호화하고 원자적으로 교체한다. 암호화 불가 시 평문으로 대체하지 않는다. **CNG software KSP와 DPAPI는 TPM/동글과 같은 보호 수준이 아니며, 같은 사용자 권한의 악성 코드·관리자·과거 snapshot 복원을 완전히 막지 못한다.** [Windows 키 생성 정책](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.cngkeycreationparameters), [Electron 저장 보호 범위](https://www.electronjs.org/docs/latest/api/safe-storage/).

CT·MRI·AP·LAT는 GPU 차례를 기다린 뒤 추론 직전에 매번 새 설치 증명을 검사한다. 모델 캐시 재사용·같은 영상 재추론도 검사한다. X-ray 가져오기는 각 inspect 직전에 분류 권한을 검사한다. AP 또는 LAT 권한이 있어야 분류를 실행할 수 있고, 이 권한이 다른 segmentation 엔진 권한을 부여하지 않는다.

이미 허가된 케이스는 회수 후에도 완료한다. 대기 중 케이스와 새 분석은 차단하며 전체 worker를 강제 종료하지 않는다. 측정·Overlay 선공개, 예약 3D, 완료 결과 열람·내보내기·파생 3D 재생성은 유지한다. 추론 권한 확인 시간은 `timings.authorization` / `License authorization`으로 분리한다. scroll·Overlay redraw마다 인증하지 않는다.

## 코드와 검증

| 역할 | 구현 |
| --- | --- |
| 규약·클라이언트 | [protocol](../desktop/security/license-protocol.cjs), [client](../desktop/security/license-client.cjs) |
| 설치 키·상태·연결 | [CNG](../desktop/security/windows-key.cjs), [DPAPI 저장](../desktop/security/storage.cjs), [runtime](../desktop/security/runtime.cjs) |
| 서버·운영자 명령 | [authority](../scripts/security/license-server.cjs), [admin](../scripts/security/internal-admin.cjs) |
| 빌드 검사 | [package](../scripts/security/package.cjs), [package.json](../package.json) |
| 앱 연결 | [main](../desktop/main.cjs), [imaging](../desktop/imaging.cjs), [상태 표시](../desktop/ui/license-status.tsx) |

```powershell
npm run test:license
npm run check
node scripts/validate-performance-checker.cjs
```

권한 테스트는 실제 서명·SQLite·HTTP·제어 가능한 시계로 수행한다. Windows 테스트는 실제 CNG 생성·서명·재시작·개인키 export 거부를 확인한다. 파이프라인 테스트는 Python/GPU만 모의 처리하고 실제 dispatcher의 안전한 완료·대기열 차단·X-ray 분류 진입점·early results를 확인한다.

[Electron 검증기](../scripts/security/validate-internal-electron.cjs)는 내부 패키지와 그 loopback authority를 받는다. 기본 경로는 이번 시험의 `release/internal/win-unpacked/resources/app.asar`와 `work/security-internal-local/authority`다. 실제 main/preload/IPC, CNG, DPAPI, 등록→승인→회수, 결과 API와 sandbox를 확인한다. 선택 대화상자만 자동 응답한다. 격리된 `outputs/security-check`에 스크린샷·검증 기록을 남기고 시험 설치 키를 삭제한다.

```powershell
npx electron scripts/security/validate-internal-electron.cjs release/internal/win-unpacked/resources/app.asar work/security-internal-local/authority
```

라이선스 검사는 환자 모델 추론을 반복하지 않는다. 전처리·overlap·fold·TTA·측정 계산은 변경하지 않았다. 이어서 수행한 MRI 로더·합성 입력 수치 검증은 아래 MRI 보호 검증에 기록했다. 실물 YubiKey, TPM, 다른 PC의 설치/삭제, OS 절전·재부팅, 전체 환자 케이스의 회귀는 별도 검증 항목이다.

2026-10-15 실행 결과: 권한/내부용 테스트 **24개 통과**, dispatcher·X-ray 분류 차단·early-results·파이프라인 검사 통과, TypeScript와 성능 보고서 검사 통과. 실제 내부 ASAR의 Electron 등록·활성화·DPAPI·회수 검사와 기존 소스 앱의 single-instance·sandbox·회전/선택·idle 렌더링 검사도 통과했다. 내부 NSIS 생성 및 내용 검사를 완료했으며 서명 상태는 `NotSigned`다. 기존 이관 파일 무결성·실패 시 설정 보존 검사도 통과했다.

고객용 흐름은 `license-demo.cjs init NEW_DIRECTORY`의 소프트웨어 모의 키로 계속 시험할 수 있다. 모의 실행기·발급 서버·관리 도구는 설치 패키지에 포함되지 않는다. 실물 PIV는 [기존 runbook](EXMO_SECURITY_POC_RUNBOOK.md)을 사용한다.

## 고객 출시까지 남은 연결

실물 PIV·attestation·ECDH, 실제 코드 서명과 서버 배포, 새 PC 설치 및 전체 환자 흐름의 현장 검증이 남았다. 전체 모델 로더와 mask/임시 결과 보호·복구의 구현 및 로컬 검증은 제품 runbook에 기록했다. 실행 코드를 수정하거나 같은 사용자 권한으로 메모리를 추출하는 공격까지 막았다고 보지 않는다.

고객용 PC + YubiKey 이중 JWE는 구현되어 합성 키로 HTTPS부터 worker까지 검증했다. 내부용은 별도 RSA-3072 CNG 복호화 키로 모델 키를 감싼다. P-256 설치 서명 키를 복호화에 재사용하지 않으며, 내부 봉투를 고객용으로 수용하지 않는다.

## 암호화 MRI 패키지와 장비별 승인

기존 원본 엔진 폴더는 유지한다. 암호화 배포물은 별도 폴더에 생성하며 샘플 영상과 평문 safetensors를 포함하지 않는다. MRI 입력을 가져올 때 Water 영상 확인은 기존 절차대로 진행한다. 새 내부 설치본의 MRI에는 아래 패키지와 모델 승인이 모두 필요하며, 일반 승인 파일만으로 평문 모델을 실행하지 않는다. 소스 개발 모드의 원본 엔진 실행은 유지된다.

EXMO 서버 운영자 PC에서 실행한다. `AUTHORITY`는 앱 build-public.json과 같은 발급 키의 디렉터리다. `OUTPUT`은 존재하지 않는 폴더여야 한다.

```powershell
node scripts/security/model-package.cjs pack-mri AUTHORITY SOURCE_EXMO_MRI OUTPUT_EXMO_MRI mri-full6-v1
node scripts/security/model-package.cjs grant-mri AUTHORITY dev-workstation-01 REQUEST.json OUTPUT_EXMO_MRI MRI-ACTIVATION.json
```

1. 새 내부 앱에서 등록 요청을 다시 저장한다. 요청에는 공개 서명 키와 별도 공개 복호화 키, 그 키를 결합하는 설치 서명이 포함된다. 기존 설치는 서명 키를 유지하고 복호화 키만 추가한다. 기록된 키가 사라졌거나 바뀌면 자동 교체하지 않고 인증을 거부한다.
2. 기존 `internal-admin approve`로 설치·MRI 권한·만료일을 승인한다. 이미 승인된 동일 설치라면 다시 등록하지 않는다. `grant-mri`는 활성 상태·미만료·MRI 사용권·등록 서명을 확인하고 발급 이력을 남긴다.
3. 별도 내부 엔진 루트의 `packages/EXMO_MRI`에 암호화 `OUTPUT_EXMO_MRI`를 배치한다. 해당 루트는 기존과 같은 `envs/{ct,mri,ap,lat}` 및 CT/X-ray 패키지, 원본 엔진 준비 기록을 갖춰야 한다. 원본 엔진의 MRI 폴더를 제자리 교체하지 않는다. `%APPDATA%/EXMO Atlas Internal/engine.json`의 `root`에 이 별도 루트를 지정한다. 소스/기존 EXMO Atlas의 설정 파일은 수정하지 않는다.
4. 해당 MRI 환경에 잠긴 보안 의존성을 설치한다. 새 엔진 준비 스크립트는 자동 처리한다. 기존 환경은 아래 명령을 한 번 실행한다.
5. 앱에서 `MRI-ACTIVATION.json`을 적용한다. 새로운 온라인 lease를 받아야 활성화되며 오프라인 사용은 기존 lease 기한만 따른다.

```powershell
uv --no-config pip install --python ENGINE/envs/mri/Scripts/python.exe --require-hashes --only-binary=:all: -r desktop/requirements-model-security.txt
```

`OUTPUT_EXMO_MRI`와 장비별 승인 파일만 설치 장비에 전달한다. **`AUTHORITY/model-keys`, issuer-private.pem, authority 원장은 전달하지 않는다.** 데이터 키는 서버에서만 보관하며 운영 계정 전용 ACL과 백업 보호가 필요하다. Windows에서 `mode: 0600`만으로 ACL이 설정됐다고 간주하지 않는다. 모델 digest별 회수는 구현했다. 자동 모델 다운로드와 자동 서명 키 회전은 제공하지 않으며 서명된 설치본·발급자 이전 절차를 사용한다.

암호화는 AES-256-GCM, 키 봉투는 RSA-OAEP-SHA256, manifest/접근권 서명은 Ed25519다. nonce와 키는 패키지마다 새로 생성한다. CNG 키는 Software KSP의 내보내기 금지 키이며 TPM 키는 아니다. [AESGCM](https://cryptography.io/en/latest/hazmat/primitives/aead/), [Node crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html).

Python worker는 빌드에 포함된 `model-policy.json`의 공개키를 사용한다. 매 실행에 worker가 새 nonce를 만들고, 앱은 실행 ID·job digest·manifest digest·lease digest·모델 키 digest·최대 60초 기한을 설치 키로 서명한다. worker는 서명과 lease를 독립 검증하고 nonce를 소비한 후에만 vendor 코드/설정을 검증하고 가중치를 연다. 시작된 작업은 만료·회수 뒤에도 안전하게 끝나며 새 작업은 다시 승인받는다. 비밀은 pipe로만 전달하며 job.json·명령행·환경변수·로그·renderer에 싣지 않는다.

내부 빌드는 Python의 보호 필수 상수를 빌드 시 고정하고 결과 파일을 다시 대조한다. 정책 파일을 지워서 개발 모드로 떨어지지 않는다. 기존 소스/legacy adapter에는 이 상수를 적용하지 않아 기존 평문 개발 경로를 유지한다. CT/AP/LAT는 이 단계에서 새 암호화 Python 의존성을 요구하지 않는다.

manifest는 코드·config·원본/암호문 hash·크기·loader 버전을 고정한다. 복호화 바이트는 원래 vendor strict loader에 전달하며 원본 해시와 ModelContract 검사를 그대로 수행한다. 평문 파일을 만들지 않는다. 가중치는 메모리에서 사용되므로 관리자/같은 사용자 공격이나 메모리 덤프까지 절대 차단하지는 못한다. Python/Torch 내부 복사본의 완전 소거도 보장하지 않는다.

`authorization`, `model_integrity`, `model_decryption` 시간을 성능 보고서에서 분리한다. 새 보호 단계의 시간을 추론 시간 감소로 계산하지 않는다.

### MRI 보호 검증

```powershell
npm run test:model-security
node scripts/security/validate-protected-mri.cjs work/modality-integration cuda:0
```

- 실제 CNG 키 생성/unwrap/개인키 export 거부, 설치 서명, 서버 승인·회수 검증.
- 변조·잘린 암호문, 코드 변조/추가, 다른 job, 잘못된 서명·키·lease, 만료·재사용 허가와 직접 CLI 실행 차단.
- 실제 model-service dispatcher에서 새로운 작업 거부가 기존 CPU 작업을 취소하지 않는지 검사. 이 검사는 수치 엔진만 모의 처리한다.
- 실제 MRI vendor strict loader를 두 경로로 호출하고 **63개 텐서 모두 동일**, RTX 3050 FP32에서 **합성 128³ 입력의 29채널 logits·argmax mask가 정확히 동일**함을 확인했다. 전처리·TTA·복원·후처리·전체 환자 케이스 추론을 재실행한 검증은 아니다.

2026-10-15 실측 기록: `work/security-mri-validation/8c2b6eea-3f77-4643-9031-568478c70c63/verification.json`. 초기 보호 확인·복호화 합계는 약 1.82초였으며 단일 cold 실행이므로 반복 성능 benchmark로 해석하지 않는다. 보호 로더는 원본 모델을 변경하지 않았고 환자 데이터를 사용하지 않았다. 전체 기존 케이스의 수치 회귀와 다른 PC 설치, 실물 YubiKey 및 고객 배포는 별도 검증 대상이다.

최종 내부 NSIS와 ASAR의 발급 키·필수 보호 상수·Python 리소스를 대조했고, 실제 Electron 등록·활성화·DPAPI·회수·결과 열람 검사도 통과했다. 기록은 `outputs/security-check/483805d4-97c0-4950-8622-5b5eafb97d5e/verification.json`이다. 현재 생성한 `release/internal/EXMO-Atlas-Internal-Setup-0.1.24.exe`는 **loopback 시험 서버에 연결하는 NotSigned 내부 시험용**이다. 외부 서버 배포나 고객 설치 완료를 뜻하지 않는다. 이관 ZIP과 운영 장비의 엔진 경로는 변경하지 않았다.

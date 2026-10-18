# P4 — 계정·기관·장비 등록 및 고객별 솔루션 권한

기준: 2026-10-18, `feat/solution-productization`. 구현과 로컬 검증 기록이다. 운영 IdP/HTTPS 배포와 실물 YubiKey 검증을 완료했다는 의미는 아니다.

## 확정한 기준

- 고객의 YubiKey 하나와 등록 PC 한 대에 장비 라이선스 하나를 연결한다. 그 아래 CT·MRI·X-ray 솔루션 권한을 각각 둔다. CT만 계약했다가 MRI를 추가해도 키/PC를 다시 등록하지 않는다.
- 키 필수/면제 정책의 승인 주체는 **EXMO 운영 관리자만**이다. Windows 관리자, 병원 관리자, 일반 사용자는 변경하지 못한다.
- 고객용은 PC 서명 + YubiKey 인증/모델 키 복호화, 내부용은 PC 서명 + 기간이 명시된 내부 승인을 유지한다. 현재 면제는 내부용 설치본/발급자/모델 패키지에 한정한다. 고객용에서 토글 하나로 YubiKey를 우회하거나 같은 설치본의 CT만 키 없이 실행하도록 만들지 않았다.
- 보안 정책은 PC 전체, 솔루션 사용 권한은 고객별·솔루션별이다. 실제 계약과 해당 모델 승인 없이 관리자 버튼만으로 임의 모델을 실행할 수 없다.
- 계정은 기관·작업공간과 장비 등록을 연결한다. 일상 분석은 기존 장비 lease로 허가한다. 로그인/로그아웃/계정 서버 장애는 분석 프로세스·결과 키·오프라인 유예를 초기화하지 않는다.

## 구현

| 영역 | 구현 위치와 동작 |
|---|---|
| Desktop 인증 | `desktop/security/account.cjs`: 시스템 브라우저 OIDC Authorization Code + PKCE S256, loopback 임시 포트, state/nonce, ID token 서명 검증, issuer/audience 검증 |
| 토큰 | main 프로세스 메모리의 access token, OS 보호 저장소의 refresh token. renderer/URL/로그/localStorage에는 전달하지 않는다. 갱신 직렬화, 전송 전 이전 refresh token 폐기, 실패 시 재로그인 |
| 계정 UI/IPC | `desktop/ui/account.tsx`, `account-ui.cjs`, preload: 계정·작업공간, PC 등록 요청, EXMO 운영자 승인, 준비된 솔루션 사용 허용/중지. origin/main frame 검증, 임의 URL/IPC 공개 없음 |
| 계정 서버 | `scripts/security/account-server.cjs`: 서명된 OIDC access JWT 검증, 서버 DB의 EXMO 역할/기관 membership, 일회성 등록 challenge, 승인 revision 경쟁 검사, 감사 기록 |
| 장비 증명 | `runtime.cjs`의 `enrollmentProof`: 기관·작업공간·challenge·등록 공개키 내용을 PC로 서명. 고객용은 YubiKey 9e 서명도 추가. 기존 모델 키 포장/9d 복호화 경로 유지 |
| 솔루션 변경 | 기존 v3 `Authority.solutions()`를 재사용한다. 같은 장비 binding에 권한을 추가하고, EXMO 운영자만 준비된 개별 권한을 허용/중지한다. 다른 솔루션의 state를 덮어쓰지 않는다 |
| 배포 | `build.json`에 선택적인 공개 OIDC 설정. 설정이 없으면 계정 서버 미설정 상태를 보여주고 기존 앱은 그대로 시작한다. ASAR에는 `openid-client`, `oauth4webapi`, `jose`만 추가하고 서버/발급자 코드는 제외한다 |

운영자 역할은 OIDC의 임의 `admin` claim이나 이메일 도메인에서 가져오지 않는다. 서버 콘솔에서 정확한 issuer의 `sub`를 등록한다. 기관 membership도 명시적으로 등록하며 역할을 제거하면 다음 API 요청부터 반영한다. EXMO 운영자에게 환자 데이터 조회권이나 기관 membership을 자동 부여하지 않는다.

운영 승인/솔루션 변경은 `amr`에 `mfa`가 있고 `auth_time`이 최근 10분인 access token을 요구한다. 실제 IdP에 이 claim 전달을 설정해야 한다. 관리자 MFA 확인을 로컬 토글로 대체하지 않는다.

## 로컬 검증

- `npm run test:accounts`: 6개 시나리오 통과. 실제 HTTP OIDC 시험 서버와 SDK로 PKCE 교환/ID 서명/nonce/잘못된 state, access token audience/scope/client/만료, refresh 직렬화, 취소/timeout, 기관 권한 제거, PC·하드웨어 증명, 재사용 challenge 거부, 운영자 MFA/권한, revision 충돌을 확인했다.
- 같은 장비 라이선스에 CT 이후 MRI 추가, 준비되지 않은 모델 활성화 거부, 한 솔루션만 중지, MRI 모델 회수 후 CT 승인 유지, 중복 등록/새 서명의 동일 장비 재등록을 확인했다.
- 실제 `openLicensing`과 v3 서버를 연결하여 계정 승인 후 장비 활성화, 로그아웃 후 `VALID` 상태와 기존 lease 파일 보존을 확인했다. 고객 하드웨어 증명은 **합성 인증서/서명**이다.
- `npm run test:license`: 24개 라이선스 테스트 및 기존 분석 파이프라인 검증 통과. 진행 중 분석 완료, 대기 작업 차단, 저장 결과 열람, Overlay 우선 공개/3D 지연, 취소/실패 처리 경로 포함.
- `npm run test:model-security`: 기존 고객용 v2/v3, CT·MRI·AP·양쪽 LAT 모델 보호, 복구/백업/패키지 무결성 9개 테스트 통과.
- `npm run test:solution-security`: JS/Python v3 판정·v2 전환·실제 보호 loader 3개 테스트 통과.
- TypeScript, 언어 키 검증, Desktop build 통과. 실행 의존성 `npm audit --omit=dev` 결과 0건. 기존 개발 도구 감사 경고는 이번 범위에서 업데이트하지 않았다.
- 격리된 Windows package의 ASAR에서 OIDC SDK를 실제 import하여 로그인했다. Electron `safeStorage`로 저장한 refresh token이 평문 파일에 없음을 확인했다. 실제 sandbox/preload/IPC/renderer에서 운영자 화면의 승인·솔루션 중지와 로그아웃을 검증했다. 기록은 `outputs/account-check/verification.json`, 화면은 같은 폴더의 PNG다.

재실행:

```powershell
npm run test:accounts
npm run test:license
npm run test:solution-security
npm run test:language
npm run check
npm run build:desktop
# 먼저 최신 코드로 내부용 package를 빌드한다. 마지막 인수는 그 app.asar 경로다.
node node_modules/electron/cli.js scripts/security/validate-account-desktop.cjs work/p4-package-check/win-unpacked/resources/app.asar
```

## 서버 연결 절차

### 1. IdP와 API

자체 비밀번호 서버는 만들지 않는다. 운영 IdP에 Desktop public client를 등록한다. client secret은 배포하지 않는다. PKCE S256 필수, loopback callback `http://127.0.0.1:<임시포트>/callback`을 native app 규칙으로 허용한다. scope는 `openid profile offline_access exmo.account`, resource는 아래 API audience다. Refresh rotation/reuse detection, MFA, 짧은 access-token 유효시간은 IdP에서 강제한다.

Desktop 공개 `build.json`에 다음 `account` 필드를 추가한다. 기존 `profile`, 라이선스 발급자 키/URL, `licenseVersion: 3`은 보존한다.

```json
{
  "account": {
    "issuer": "https://identity.example.org/realms/exmo",
    "clientId": "exmo-desktop",
    "apiUrl": "https://accounts.example.org",
    "resource": "https://accounts.example.org"
  }
}
```

서버의 `oidc.json`:

```json
{
  "issuer": "https://identity.example.org/realms/exmo",
  "audience": "https://accounts.example.org",
  "clientId": "exmo-desktop",
  "jwksUrl": "https://identity.example.org/realms/exmo/protocol/openid-connect/certs"
}
```

access token은 `sub`, `iat`, `exp`, API용 `aud`, `azp` 또는 `client_id`, `scope: exmo.account`가 필요하다. 운영자 변경에는 앞의 `amr`/`auth_time`도 필요하다. ID token을 API bearer로 사용하지 않는다.

```powershell
node scripts/security/account-server.cjs serve AUTHORITY_DIR oidc.json 43128
node scripts/security/account-server.cjs operator AUTHORITY_DIR OIDC_SUB on
node scripts/security/account-server.cjs member AUTHORITY_DIR OIDC_SUB hospital-a research "Research" device-admin
# 역할 회수: operator ... off / member ... none
```

서버는 `127.0.0.1`에서만 수신한다. HTTPS reverse proxy에서 `/v1/me`, `/v1/enrollments` 및 해당 하위 경로만 전달하고, 크기 제한 256 KiB/속도 제한/짧은 timeout을 적용한다. Authorization header는 전달하고 토큰·body를 access log에 기록하지 않는다. 브라우저 Origin/CORS 요청은 지원하지 않는다. Web용 BFF는 P7 별도 범위다. 운영 issuer는 DB에 고정되며 다른 issuer로 바꾸면 기존 `sub` 권한을 재사용하지 못한다.

고객용/내부용 authority와 API 배포는 분리한다. 이 앱의 `allowLoopback` 테스트 예외는 내부용만 가능하고 고객용은 HTTPS를 요구한다. 계정 테이블과 issuer 고정값은 기존 authority SQLite에 있어 기존 백업/복원 대상에 포함된다. 공개 IdP/API 설정은 별도 배포 설정으로 백업한다.

### 2. 첫 장비 등록과 운영 승인

1. 기관의 `device-admin` 계정으로 앱 로그인 → 작업공간 선택 → 이 PC 등록 요청. 고객용은 PC + 실물 YubiKey 증명이 필요하다.
2. EXMO 서버 콘솔에서 요청을 내보낸다.

   ```powershell
   node scripts/security/account-server.cjs export-request AUTHORITY_DIR ENROLLMENT_ID enrollment.json
   ```

3. 기존 `internal-admin.cjs` 또는 `customer-admin.cjs`로 동일 요청을 승인하고, `model-package.cjs grant-model`과 `solution-admin` 경로로 계약한 모델·v3 execution pin·기관을 준비한다. **고객용 하드웨어 제조사 attestation 검증은 기존 customer-admin 절차를 그대로 거친다.** 고객용 activation에는 기관의 서명된 결과 recovery 설정도 포함한다.
4. 모델별 activation의 `models`를 같은 binding 아래 합친 파일을 서버에 준비한다. 이 파일에는 PC/동글에 감싼 모델 키만 들어가며 평문 모델 키는 클라이언트로 보내지 않는다.

   ```powershell
   node scripts/security/account-server.cjs prepare AUTHORITY_DIR ENROLLMENT_ID activation.json
   ```

5. 초기 승인은 이 시점에 `suspended`로 대기한다. EXMO 운영자가 MFA 로그인하여 요청의 기관/PC/키 정책/솔루션을 검토하고 승인한다. 서명 승인이 미준비인 요청은 승인 버튼이 비활성이다.
6. 해당 PC의 기관 장비 관리자가 갱신 → 승인 적용. main이 기존 설치 신원과 발급자 서명을 확인하고 **fresh online v3 lease**를 받은 뒤 기존 activation 저장 경로로 적용한다.

운영 서버의 발급 CLI는 기존과 같이 신뢰된 EXMO 운영자 전용이다. 계정 API가 issuer private key, 임의 파일 업로드/명령 실행, 사용자별 임상 데이터를 공개하지 않는다. 첫 발급의 모델/계약 준비는 콘솔 절차가 남아 있으며 완전 자동 계약/결제 UI는 아니다.

### 3. 같은 키에 솔루션 추가

예: 기존 CT 고객에게 MRI 추가.

```powershell
# EXMO 운영 서버 콘솔에서만 실행. v3 모델 발급 준비 범위를 확장하며 이것만으로 분석 권한을 주지 않는다.
node scripts/security/account-server.cjs enable-engines AUTHORITY_DIR ENROLLMENT_ID mri
# 기존 grant-model로 MRI 포장 키를 발급하고, solution-admin으로 MRI execution pin을 추가한다.
# 초기 state는 suspended로 두고 기존 CT entitlement를 보존한다.
node scripts/security/account-server.cjs prepare AUTHORITY_DIR ENROLLMENT_ID mri-activation.json
```

`prepare`는 기존 승인과 같은 장비 binding인지 검사하고 모델 권한을 병합한다. 이미 승인된 장비의 전체 라이선스를 중지하지 않는다. EXMO 운영자가 화면의 MRI 권한을 허용하고, 고객 PC에서 새 승인을 적용/갱신하여 MRI를 선택 설치한다. 키/PC/licenseId는 유지된다. 다른 솔루션의 권한·설치·저장 결과를 지우지 않는다.

분석 중인 작업은 기존 정책대로 마무리한다. 중지/회수는 다음 서버 갱신 이후 신규 작업에 반영되며, 완전히 오프라인인 PC에 즉시 강제할 수는 없다. 기존 최대 7일 유예/동글 인증 규칙이 유지된다.

## 남은 작업과 명시적 범위

- 운영 서버/도메인/실제 IdP의 callback·claim mapping·MFA·refresh 회수 설정, HTTPS/방화벽/서비스 계정 배포 검증.
- 실물 YubiKey 5C NFC 5.8의 attestation/등록/재연결/분실 및 새 PC 테스트, 코드 서명된 고객 설치본 검증.
- 계정 목록·등록 요청은 현재 최대 200개를 반환한다. 고객 수 확대 전에 서버 pagination/filter와 운영 콘솔을 확장한다.
- 실시간 access JWT 회수는 IdP introspection을 연결하지 않았다. 서버 membership/운영 역할 회수는 즉시 반영되며 탈취 JWT 자체는 짧은 만료/IdP 정책으로 제한한다.
- P5 서버 게시/outbox/metrics·QC/GLB 저장과 P7 Web·태블릿 조회는 아직 구현하지 않았다. 이 단계의 네트워크 전송에는 원본 영상, mask, metrics, 렌더링 결과가 없다.
- 모델·전처리·정밀도·좌표 복원·후처리 코드는 변경하지 않았다. 실제 CT/MRI/X-ray GPU 추론을 이 계정 변경 때문에 다시 수행하지 않았다.

프로토콜 근거: [native app OAuth](https://www.rfc-editor.org/rfc/rfc8252.html), [OAuth 보안 권고](https://www.rfc-editor.org/rfc/rfc9700.html), [openid-client](https://github.com/panva/openid-client), [jose](https://github.com/panva/jose).

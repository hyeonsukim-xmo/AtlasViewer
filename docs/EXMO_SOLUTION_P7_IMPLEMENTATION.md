# P7 첫 단계 — Web 읽기 전용 결과 Viewer

2026-10-18 · `feat/solution-productization`

## 구현 범위

이번 단계는 **웹 로그인 → 기관·작업공간 선택 → 서버 결과 목록/검색 → 단일 결과의 측정·QC·대표 Overlay·3D 열람**이다. `npm run build:viewer`로 `dist-viewer`에 별도 빌드한다. 기존 `npm run build` 웹 atlas 데모와 Desktop 빌드는 유지한다.

- 임상 Viewer의 측정 표, QC, 구조 선택, 회전, Explode/Assemble, 대표 Overlay 표시를 재사용한다.
- 결과 목록은 행 전체 클릭 및 Enter/Space로 연다. 목록 복귀, 작업공간 변경, 로그아웃이 가능하다.
- 서버에는 가명 Case/Study ID만 있으므로 원래 환자명이나 촬영일을 만들어 표시하지 않는다.
- 대표 Overlay는 승인된 **고정 PNG 한 장**이다. 전체 영상·slice stack이나 현재 구조 선택을 반영하는 실시간 Overlay가 아니다.
- 승인된 PNG가 없으면 측정/QC만 열람한다. 3D 후속 게시를 기다리는 결과는 목록과 열린 결과를 갱신한다.
- Web에 영상 입력·분석·후처리 실행·결과 게시·Desktop IPC·모델·native Mask를 포함하지 않는다. 빌드 검사가 이 경계를 확인한다.
- Desktop 전용 동작은 `local-result-view.tsx`로 옮겨 기존 로컬 호출부에 연결했다. 공용 `result-view.tsx`에는 Desktop IPC 호출이 없다.

**P7 전체 완료는 아니다.** 웹 최대 3건 비교, LT/AP/RT 촬영 묶음, 물리 태블릿의 터치/브라우저 검증은 다음 단계다. 기존 Desktop의 비교·X-ray 묶음은 그대로 유지한다.

## 인증과 권한

`scripts/security/viewer-server.cjs`는 기존 Desktop API와 별도의 loopback BFF다. Desktop 업로드/장비 승인/운영 관리자 API를 웹에 프록시하지 않는다.

1. 등록된 OIDC 웹 클라이언트의 Authorization Code + PKCE S256, state, nonce, issuer/audience/client ID, 서명 검증을 사용한다. 운영에서는 confidential client secret이 서버에만 존재한다.
2. 토큰·refresh token은 BFF 메모리에만 보관한다. 브라우저에는 무작위 opaque session cookie만 전달한다. HTTPS에서는 `__Host-exmo-viewer; Secure; HttpOnly; SameSite=Lax; Path=/`을 사용한다.
3. 로그인 성공 시 session ID와 CSRF token을 교체한다. POST는 정확한 Origin, session CSRF header, 제한된 JSON body를 검사한다. redirect는 고정된 callback과 `/`만 허용한다.
4. 같은 issuer에 연결된 account DB의 **현재** membership을 조회한다. analyst/reviewer/data-admin만 열람한다. 운영 관리자 또는 device-admin 권한만으로는 환자 결과를 열람할 수 없다.
5. 웹 열람에는 PC 등록·YubiKey·신규 분석 권한을 요구하지 않는다. Desktop 실행 권한과 계정의 데이터 접근권은 독립적이다. Desktop API의 기존 PC proof 검사는 바꾸지 않았다.
6. 매 결과/asset 요청에서 권한을 재검사한다. 작업공간 전환 때 scope nonce가 바뀌므로 이전 이미지/3D URL을 재사용할 수 없다. 삭제·attachment revision/hash 변경도 거부한다.
7. GLB/PNG만 제공하며 verifier가 검증한 display copy를 읽는다. 1 MiB 단위의 전송에서도 세션·권한·revision을 검사하고 최종 SHA-256을 확인한다. native Mask와 복호화 키를 제공하는 endpoint는 없다.

세션은 최대 8시간, 요청 없는 시간 기준 30분이다. access token은 서버에서 갱신하며 갱신 실패 시 다시 로그인한다. refresh token은 전송 전에 기존 값을 폐기하여 모호한 응답 후 재사용하지 않는다. 로그아웃은 서버 세션을 먼저 무효화하고 가능한 경우 IdP token도 회수한다. IdP 자체의 SSO 세션 전체 로그아웃은 하지 않으며 다음 로그인은 계정 선택을 요청한다.

### 브라우저 정리

- 모든 응답은 `Cache-Control: no-store`. CSP, frame 차단, same-origin resource policy, no-referrer를 설정한다.
- 결과·토큰을 localStorage/IndexedDB/Service Worker에 저장하지 않는다. 언어 설정만 기존 localStorage를 사용한다.
- 로그아웃, 권한 실패, 작업공간 변경 시 화면과 진행 중 detail 요청을 정리한다. 같은 origin의 다른 탭에 변경 알림을 보내며, 복귀와 15초 주기로 현재 세션/권한을 다시 확인한다.
- 서버에서 권한을 회수하면 다음 API 요청부터 차단한다. **이미 브라우저에 전달한 픽셀·geometry를 회수하거나 캡처를 막는 보장은 없다.** 열린 화면의 자동 제거는 재검사 시점에 이루어진다.
- BFF 재시작 시 세션은 사라지고 재로그인이 필요하다. V1은 단일 인스턴스이며 세션 상한 1,000개와 최신 결과 200개 제한이 있다. 다중 노드·더 큰 목록은 별도 작업이다.

## 배포 준비

실제 서버/IdP가 제공되면 다음을 설정한다. 현재 운영 서버에는 배포하지 않았다.

1. `npm ci`, `npm run build:viewer`를 수행한다. `dist-viewer`만 웹 정적 파일로 사용한다. `public`, `dist-desktop`, 결과 object 폴더를 웹 정적 루트로 노출하지 않는다.
2. 기존 계정 DB에 고정된 issuer와 동일한 IdP에 **별도 웹 confidential client**를 등록한다. redirect는 `https://viewer.example.org/auth/callback` 한 개, scope는 `openid profile offline_access exmo.account`, resource/audience는 기존 계정 서비스 값을 사용한다. 웹 client ID로 발급한 access token의 `azp`/`client_id`가 일치해야 한다.
3. 공개 설정 파일을 준비한다. secret은 파일에 넣지 않고 서버의 비밀 환경 변수 `EXMO_VIEWER_CLIENT_SECRET`로 전달한다.

```json
{
  "origin": "https://viewer.example.org",
  "issuer": "https://identity.example.org",
  "clientId": "exmo-viewer",
  "resource": "https://account.example.org",
  "jwksUrl": "https://identity.example.org/jwks"
}
```

```powershell
node scripts/security/viewer-server.cjs RESULT_DIR ACCOUNT_DIR RESULT_PUBLIC_CONFIG.json VIEWER_CONFIG.json dist-viewer 7818
```

4. 같은 호스트의 HTTPS reverse proxy가 고정 origin의 Host를 보존하여 `127.0.0.1:7818`로 전달한다. BFF 포트를 외부에 열지 않는다. TLS 종료, 접속 제한/요청률 제한, 민감한 query/cookie/token 로그 제외를 설정한다. forwarded header로 origin을 결정하지 않는다.
5. BFF는 account DB를 읽기 전용으로 연다. result DB에는 조회와 감사 기록이 필요하다. native Mask·display 파일은 기존 결과 저장소의 암호화 디스크/OS ACL로 보호하며 private verifier의 키를 BFF 프로세스에 주지 않는다. 브라우저 응답/파일경로에는 Mask를 노출하지 않는다.
6. 운영 HTTPS cookie, 실제 IdP MFA/만료/회수, 역방향 프록시, 백업/복원, 동시 사용자 부하와 실제 태블릿을 검증한 후 공개한다.

테스트 factory만 명시적으로 loopback HTTP를 허용한다. 운영 CLI에는 이 예외 옵션이 없다. Viewer의 HTTP 개발 예외가 고객 Desktop의 키 정책을 완화하지 않는다.

## 검증 및 재현

```powershell
npm run check
npm run test:language
npm run build:viewer
npm run test:viewer
npm run test:remote
npm run build:desktop
node node_modules/electron/cli.js scripts/security/validate-publication-desktop.cjs --archived-reader --overlay --viewer --remote
```

자동 검증은 실제 OIDC code/PKCE와 임시 계정/결과 서비스를 사용한다. PC 없는 reviewer 로그인, CSRF/다른 Host·기관 차단, 재전송 callback, nonce 불일치, 금지 endpoint, 권한 회수, 로그아웃, 가명 projection, PNG/GLB hash, stale scope/revision, 삭제를 검사한다. 실제 화면 검증은 기존 보호된 QA 결과를 게시한 후 **preload/Node/IPC 없는 HTTP 브라우저**에서 연다. CT/MRI 3D·측정/QC, CT/MRI/AP/LT/RT 대표 이미지 hash, workspace 변경·로그아웃·재로그인·권한 회수, 820×1180 viewport를 확인한다. 기록은 `outputs/publication-desktop-check/<run>/web-verification.json`과 `web-*.png`다.

2026-10-18 실행 결과:

- `check`, 737개 번역 검사, Viewer/기존 데모/Desktop 빌드 통과. Viewer 산출물에 Desktop IPC·입력·게시 코드와 모델/Mask 파일이 없는지 검사했다.
- `test:viewer` 2개 통합 시나리오, `test:accounts` 6개, `test:remote` 6개, 기존 GLB/interaction 검사 통과.
- 실제 화면 통과 기록: `outputs/publication-desktop-check/5de1a7e7-d555-4d10-9d89-df6721e6eb8b/`. `web-verification.json`, `overlay-verification.json`, `remote-verification.json`, 최종 `verification.json`이 통과했고 프로세스가 정상 종료했다. CT/MRI 3D의 실제 마우스 드래그 전후 이미지 변화도 검사했다.
- `web-list.png`, `web-mri-3d.png`, `web-tablet.png`를 직접 확인했다. 초기 UI 자동화에서 제어 완료 대기/DOM 반환값 처리를 바로잡았고, 숨김 창 대신 표시된 테스트 브라우저에서 실제 프레임을 검증했다.
- 세션 polling 때문에 3D 모델을 다시 생성하지 않도록 결과 props를 안정화했다.

새 추론, 모델 수치 비교, 실제 Safari/iPad/YubiKey/운영 HTTPS 서버 검증은 이 단계에 포함하지 않는다.

## 되돌리기

Viewer BFF를 중지하고 기존 Desktop/데모 빌드를 계속 사용하면 된다. 이번 단계는 DB column/schema를 변경하지 않으며 분석 모델·입출력 좌표·계산 정밀도도 변경하지 않는다. 이전 코드로 돌아갈 때 기존 대표 Overlay 저장소의 호환성/백업 규칙은 [대표 Overlay 구현 기록](EXMO_REPRESENTATIVE_OVERLAY_IMPLEMENTATION.md)을 따른다.

# EXMO 결과 서비스 / Web Viewer 운영 인계

2026-10-18. 단일 Linux 호스트 기준의 배포 템플릿과 로컬 복구 검증이다. **실제 운영 서버 배포 완료를 의미하지 않는다.** 모델 실행은 계속 Desktop에서 이루어진다. 웹은 게시된 측정·QC·승인된 GLB/PNG만 읽는다.

## 산출물 생성

```text
npm ci
npm run build:viewer
node scripts/security/viewer-deploy.cjs viewer.example.org NEW_DEPLOY_DIR
```

기존 폴더를 덮어쓰지 않는다. 생성한 `viewer.json`의 예시 issuer/resource/JWKS를 실제 값으로 바꾼다. `viewer.env.example`은 비밀 저장소에서 발급한 실제 confidential client secret으로 `/etc/exmo/viewer.env`에 설치한다. 예시 값으로 서비스를 시작하지 않는다. repo와 로그에 secret을 넣지 않는다.

| 구성 | 실행 사용자 / 접근 범위 | 내부 포트 |
|---|---|---|
| 기존 account/license | 기존 authority 사용자. 발급 키·계정 관리 | 기존 설정 |
| exmo-results | exmo-results. account DB 읽기, result DB/암호화 object 쓰기 | 127.0.0.1:7817 |
| exmo-verifier | **별도 사용자 exmo-verifier**. result 저장소, verifier private key | 네트워크 listener 없음 |
| exmo-viewer | exmo-results. 현재 membership 확인, 감사 기록, 승인 display 읽기 | 127.0.0.1:7818 |
| nginx | 외부 TLS 종료. Viewer와 기존 Desktop API 별도 host | 443 |

Viewer에 발급용 키, mask/mesh 복호화 키, 모델 파일을 주지 않는다. Viewer URL의 `/v1/`은 차단한다. Desktop 계정 API의 기존 TLS server에만 `publication-location.conf`를 넣는다. 인증·장비 증명은 backend에서 계속 검사하며 프록시에서 우회하지 않는다.

## OS 권한과 설치 순서

1. Node는 개발 검증 버전과 맞추고 `node:sqlite`가 있어야 한다. `npm ci`로 lockfile을 사용한다. Node 런타임 갱신은 아래 통합 테스트 후 적용한다. 코드와 `dist-viewer`는 root 소유로 설치하고 서비스 사용자는 쓰지 못하게 한다.
2. `exmo-results`, `exmo-verifier` 시스템 사용자를 만든다. 두 사용자는 `exmo-results` 그룹으로 **결과 저장소만** 공유한다. `/var/lib/exmo-results`와 하위 디렉터리는 `2770`, DB/object 파일은 `0660`. result/verifier 서비스 umask는 `0007`이다. verifier는 디렉터리의 setgid를 통해 공유 그룹을 상속한다. 승인 display와 암호화 chunk 저장은 group rw로 원자적으로 교체한다. 일반 키·라이선스 저장의 기본 `0600`은 유지한다.
3. `/etc/exmo/verifier-keys`는 exmo-verifier 소유 `0700`, 내부 `mask.pem`, `mesh.pem`, `receipt.pem`은 `0600`. 새 설치에만 `result-verifier.cjs init PRIVATE_DIR PUBLIC_CONFIG`를 실행한다. **기존 배포에서 새 키를 생성해 덮어쓰지 않는다.** 기존 키는 별도 암호화된 관리자 보관소에 백업한다.
4. account authority 디렉터리는 기존 소유자를 유지한다. `exmo-account-read` 그룹에 디렉터리 탐색과 `authority.sqlite`, WAL/SHM 읽기만 허용한다. result/viewer는 이 보조 그룹에 포함한다. private PEM과 model-keys는 공유하지 않는다. SQLite WAL 생성 시 새 파일의 group/read 권한도 유지되도록 실제 계정 서비스 사용자와 함께 설정한다. DB를 열 수 있는지 **서비스 사용자로** 검증한다. 폴더 전체에 읽기 권한을 일괄 부여하지 않는다.
5. 결과 공개 설정의 `oidc`는 Desktop API 클라이언트 기준 `{issuer,audience,clientId,jwksUrl}`이다. 별도 `viewer.json`은 웹 클라이언트의 `{origin,issuer,clientId,resource,jwksUrl}`이다. 두 issuer는 account DB에 pin된 값과 같아야 한다. 공개 RSA/receipt key들은 verifier private key와 일치해야 한다.
6. 웹 IdP client는 confidential, PKCE S256, redirect `https://HOST/auth/callback` 한 개, `openid profile offline_access exmo.account` scope와 account resource를 사용한다. 웹 client ID가 access token의 azp/client_id에 들어가는지 확인한다. MFA는 실제 IdP 정책으로 적용한다.
7. TLS 인증서 설치 후 `nginx -t`, `systemd-analyze verify`로 생성 파일을 검사한다. results → verifier → viewer 순으로 시작한다. 초기 result DB를 results 사용자/umask로 생성해야 공유 권한이 유지된다. 복원한 저장소에도 이 권한을 적용한다. 세 서비스는 재시작 시 정상화되지만 BFF 세션은 메모리이므로 다시 로그인해야 한다.

템플릿은 승인 전에 실제 호스트의 경로·사용자·계정 서비스 구성에 맞춰 확인해야 한다. 이 Windows 개발 환경에서는 Linux uid/group, nginx, systemd를 실행 검증하지 않았다.

## 가동 확인과 장애 대응

호스트 내부에서 실제 Host를 명시한다. health는 외부 nginx에서 차단한다.

```text
curl --fail -H 'Host: viewer.example.org' http://127.0.0.1:7818/health/ready
```

`{"ready":true}`는 result/account DB 조회와 정적 index 읽기가 가능하다는 뜻이다. IdP 연속 가용성이나 verifier 처리 성공까지 보증하지 않는다. 로그에 token, callback query, 환자 식별자, Mask를 남기지 않는다. nginx 템플릿은 민감 query 노출을 피하기 위해 access/error 로그를 끈다. 운영 모니터링에는 status/latency만 별도로 수집한다.

| 실패 | 확인 및 복구 |
|---|---|
| 시작 실패 / 503 health | DB/파일 권한, 디스크 공간, config·issuer 불일치, IdP discovery 연결. 설정 수정 후 서비스 재시작 |
| 401 / 갱신 실패 | 세션 폐기 후 재로그인. IdP 만료·회수·네트워크 확인 |
| 403 | 현재 기관/workspace membership, HTTPS Host·Origin/CSRF 확인. PC 키 정책을 끄는 것으로 해결하지 않음 |
| 409 asset | 작업공간 또는 attachment revision이 바뀐 URL. 목록을 갱신해서 새 detail 열기 |
| 404 결과 | 삭제 또는 다른 workspace. 이전 URL을 재사용하지 않음 |
| 3D/PNG unavailable | verifier 가동·공유 그룹·원본 암호화 chunk 검사. `result-verifier.cjs once` 후 다시 열기 |
| quota / 디스크 부족 | 저장소 여유·조직 quota 확인. 감사·삭제 기록을 임의 삭제하지 않음 |
| 서버 정지 | 기존 Desktop 로컬 결과는 유지. 웹 신규 읽기는 실패하고 화면을 정리함. 복구 후 재로그인 |

권한/삭제는 매 요청 및 asset chunk마다 확인한다. 열린 웹 화면은 복귀/15초 polling에서 재확인한다. 이미 전송한 픽셀·geometry를 원격 회수하거나 캡처를 금지할 수는 없다.

## 백업과 복원

**유지보수 시간에 account/license/results/verifier/viewer 쓰기 작업을 먼저 정지한다.** 아래 도구는 서비스 간 live snapshot을 조정하지 않는다. 두 DB의 시점이 다르면 이전 권한·삭제 상태가 복구될 수 있다. 업로드는 Desktop 대기열에 남으며 복원 후 재개한다.

```text
node scripts/security/server-ops.cjs backup AUTHORITY_DIR NEW_AUTHORITY_BACKUP
node scripts/security/results-ops.cjs backup RESULT_DIR RESULT_PUBLIC_CONFIG RECEIPT_PRIVATE_PEM NEW_RESULT_BACKUP
node scripts/security/server-ops.cjs verify AUTHORITY_BACKUP TRUSTED_ISSUER_PUBLIC_PEM
node scripts/security/results-ops.cjs verify RESULT_BACKUP TRUSTED_RESULT_PUBLIC_CONFIG
```

결과 백업은 SQLite, 암호화 chunk, 승인된 GLB/PNG, 공개 config와 서명된 파일 목록이다. 변경/누락/추가 파일을 거부하고 기존 대상 폴더에 복원하지 않는다. 가명 연결, 감사 기록과 삭제 tombstone을 유지한다. **GLB/PNG는 표시용 평문 데이터**이므로 백업 전체를 암호화된 접근 제한 저장소에 둔다. 백업만 있으면 충분한 것이 아니다: verifier private key, authority 발급키/model-keys, IdP 설정/사용자 관리, TLS·웹 client secret의 별도 복구 수단을 보관한다.

```text
node scripts/security/server-ops.cjs restore AUTHORITY_BACKUP TRUSTED_ISSUER_PUBLIC_PEM NEW_AUTHORITY_DIR
node scripts/security/results-ops.cjs restore RESULT_BACKUP TRUSTED_RESULT_PUBLIC_CONFIG NEW_RESULT_DIR
```

신뢰할 공개키/config는 백업과 별도로 보관한 것을 쓴다. 복원한 result directory의 `public.json`과 기존 key escrow가 일치하는지 확인한다. 새 디렉터리에서 DB/권한 검증 후 서비스 경로를 전환한다. 예전 서버와 복원 서버를 동시에 쓰기 가능 상태로 운영하지 않는다. 백업 시점 이후의 회수/삭제/정책 변경은 감사 원장과 대조해 재적용한 뒤 외부 접근을 연다. 복원 후 verifier·웹 테스트 계정·각 modality 표시를 확인한다.

## 공개 전 실제 환경 통과 기준

- 실제 IdP/HTTPS 로그인, PKCE·MFA·token 갱신/회수·로그아웃, 서로 다른 기관/workspace 접근 차단.
- Desktop CT/MRI/AP/LT/RT 게시 → verifier → 웹 측정/QC/PNG/GLB, 3건 비교·X-ray 누락/중복 방향.
- verifier를 별도 uid로 실행한 뒤 chunk 읽기/display 쓰기 가능, Viewer 사용자로 private key 읽기 불가.
- role 회수·결과 삭제·서버 재시작 후 이전 화면/URL 차단.
- 실제 iPad Safari/Android Chrome: 탭, 드래그, pinch, 구조 회전, 좁은 화면 표 스크롤, 3개 모델의 메모리 및 context loss.
- 목표 사용자 수에서 목록/최대 3 GLB 동시 열람의 p50/p95 latency, 메모리, 디스크, DB busy를 측정. 현재는 단일 BFF, 최대 1,000 세션, 최신 200건이다. 클러스터 세션/페이지네이션은 별도 규모 변경이다.
- 별도 디렉터리 복구 훈련. 실물 YubiKey 5C NFC/5.8 고객용 분석 권한은 Desktop에서 별도로 실측한다.

이 기준에 필요한 실제 서버·IdP·태블릿·YubiKey 결과가 없으면 운영 검증 완료로 표시하지 않는다.

# 대표 Overlay 게시·열람 구현 기록

기준: 2026-10-18, `feat/solution-productization`, P6 `c7d685f` 이후. [제품화 계획](EXMO_SOLUTION_PRODUCTIZATION_PLAN.md)의 P5 대표 영상 승인 경로와 P6 Desktop 열람을 연결했다. 실제 운영 서버와 Web/태블릿 출시는 별도 단계다.

## 사용 흐름

1. 로컬 결과의 Overlay 화면에서 방향·슬라이스·CT window·구조 선택·투명도를 정하고 **대표 Overlay 게시**를 누른다. 로그인 및 현재 작업공간의 analyst 권한이 필요하다.
2. 현재 analysisRevision의 고정 snapshot을 다시 확인하고, 해당 Reader로 대표 PNG를 생성한다. CT/MRI는 선택한 한 슬라이스, X-ray는 AP/LT/RT 각각의 projection이다. 환자 메타데이터는 사본 DTO에 포함하지 않는다.
3. 드래그 또는 픽셀 좌표로 식별 영역을 지정한다. 최종 사본 검토 시 main이 RGB 픽셀을 검정으로 덮고 새 PNG를 만든다. CSS 가림을 게시하지 않는다. 확대·스크롤로 최종 픽셀을 확인할 수 있다.
4. 최종 이미지가 실제 로드된 뒤 확인 체크와 **확인한 사본과 결과 게시**로 승인한다. 수정하면 확인 체크가 초기화된다. 최종 SHA-256이 달라지거나 계정/workspace/결과 revision이 바뀌면 과거 확인으로 게시할 수 없다.
5. 원래 결과가 미게시라면 기존 측정/QC·암호화 Mask를 먼저 게시한다. 승인 사본은 독립 attachment로 전송하며 GLB도 기존 경로로 후속 게시한다. 기존 결과 게시 버튼은 이미지 승인 없이 계속 사용할 수 있다.
6. 서버 결과의 **Overlay·측정·QC**에서 승인 PNG를 열람한다. X-ray Study의 LT/AP/RT 순서와 누락 방향 처리는 기존 P6 기능을 이용한다. **결과 revision당 대표 이미지 한 장**이며 재게시하면 현재 대표 사본을 교체한다.

원격 이미지는 고정된 표시 사본이다. 구조 선택에 따라 색이 바뀌거나 임의 슬라이스를 스크롤하지 않는다. 촬영 방향·슬라이스 번호·opacity·식별영역 제거 여부를 표시하고 이 제한을 화면에 명시한다. 원본 영상, 전체 slice stack, native Mask, 확률 배열을 원격 Viewer에 제공하지 않는다.

## 데이터와 권한 경계

| 구간 | 구현 |
| --- | --- |
| 로컬 확정 영상 | `imaging.publicationPreview`: 기존 Reader snapshot digest 확인 후 기존 preview 생성. 모델·전처리·좌표 복원·정밀도·후처리 계산 변경 없음 |
| 검토 | `overlay-review.cjs`: 계정·대상·고정 revision에 묶인 메모리 draft 하나, 30분 제한. 취소/계정 변경/새 draft는 이전 승인을 무효화 |
| 사본 형식 | `publication-image.cjs`: opaque RGB8 PNG만 허용. IHDR/IDAT/IEND 및 CRC·zlib 실제 길이·filter·크기 검증. metadata/alpha/animation 제외. 최대 2048×2048, 16 MiB, IDAT 256개 |
| 승인 | `privacyReview`: 고정 정책 `exmo-no-identifiers-v1`, 최종 PNG hash, permittedIdentifiers=`none`, 가림 적용 여부, 게시자 subject, 확인 시각 |
| 대기열 | 승인된 PNG만 Windows safeStorage 파일에 저장. unapproved 원본 사본은 메모리만 사용. 승인 후 네트워크 장애 시 기존 outbox 재시도/재개 사용. 게시 완료·취소 시 PNG 대기 파일 삭제 |
| 전송 | 기존 1 MiB multipart, AES-256-GCM, artifact kind를 포함한 AAD, RSA-OAEP. Overlay는 표시 자산용 mesh key를 재사용하고 native Mask 키와 분리 |
| 서버 검증 | 현재 membership·기관/workspace·승인 PC proof·origin 검사. 최종 hash/게시자/정책/시각, PNG 형식·크기 재검증. private verifier의 서명 receipt가 있어야 공개 |
| 서버 저장 | 기존 publications 컬럼 유지. `publication_overlays(result, attempt)` 추가. immutable 분석 contentDigest는 변경하지 않고 attachment revision만 증가 |
| 충돌 | attachment CAS 실패는 자동 덮어쓰지 않음. 전송 취소 후 최종 사본 재검토·게시 필요. 불완전/실패 교체는 기존 게시 사본을 유지 |
| 원격 열람 | `overlay-part`에서 현재 결과 revision·hash·기관 ACL을 매 part 검사. main 임시 `atlas://app/remote/<id>.png`, byte count/hash 검증, no-store. 로그아웃·workspace 변경·화면 종료 시 핸들 폐기 |
| 삭제 | 결과 tombstone 즉시 접근 차단, overlay 연결 제거, 기존 sweep에서 암호문과 표시 사본 정리. 진행 중 교체 취소는 기존 게시 결과를 삭제하지 않음 |

표시 사본 `objects/<attempt>/display.png`는 검증된 **평문 표시 자산**이다. GLB와 동일하게 서버의 암호화 볼륨·OS ACL로 보호해야 한다. HTTP API에는 native Mask 개인키를 주지 않는다. 승인 기록은 식별정보에 대한 사용자의 확인이며 자동 익명화 보증이나 임상 QC 승인이 아니다. 식별정보가 제거됐는지는 사람이 최종 픽셀을 검토해야 한다.

## 업데이트·되돌리기

- Result API와 verifier를 함께 업데이트한 뒤 Desktop을 업데이트한다. 기존 receipt/Mask/mesh 키를 그대로 사용한다. 새 서버의 `info.overlayPolicy`로 지원 여부를 확인하며 구서버에는 이미지를 전송하지 않는다. 기본 이미지 없는 P5/P6 게시·열람 요청은 유지한다.
- 서비스 정지 후 SQLite DB+objects를 일관된 시점에 백업한다. 기존 contentDigest, Mask, 결과 ID, context는 그대로 둔다.
- **Overlay 게시 후 구버전 서버를 같은 DB에 직접 실행하지 않는다.** 이전 sweep은 새 overlay 연결 테이블을 알지 못하여 유지해야 할 image attempt를 만료 처리할 수 있다. 되돌릴 때는 서버/worker/Desktop과 업데이트 전 DB+objects 백업을 함께 복원한다. 업데이트 후 생성한 결과는 별도 보존하고 복원 범위를 결정한다.
- 이전 Desktop은 새 서버에서도 이미지 없는 기존 기능을 사용할 수 있다. 로컬 원본과 확정 분석 결과는 이번 기능의 삭제/교체 대상이 아니다.
- 개인정보 유지 정책, OCR, 자동 식별영역 탐지, 다중 slice gallery, 임상 QC 승인, 독립 Overlay 삭제 UI는 추가하지 않았다. 현재 정책은 식별정보 없는 최종 사본 한 장이다. 오프라인에서 최초 검토를 시작하는 기능도 없으며, 온라인 계정 확인 후 승인된 전송의 오프라인 재개를 지원한다.

## 검증

```text
npm run test:overlays
npm run test:publications
npm run test:remote
npm run check
npm run test:language
npm test
npm run build:desktop
node node_modules/electron/cli.js scripts/security/validate-publication-desktop.cjs --archived-reader --overlay --remote
```

- Overlay 테스트: PNG/픽셀 가림·메타데이터/손상/과대해제 거부, 승인 hash/현재 계정/취소 경계, 암호화 outbox 재시작, 실제 OIDC/PC proof·private verifier·read ACL·삭제, 잘못된 사본 교체 시 기존 이미지 보존, 여러 part 중단 후 누락 part만 재전송.
- Publication 8개, Remote 6개 회귀 통과. TypeScript·한영 문구·기존 GLB/상호작용 검사 및 Desktop 빌드 통과. 기존 큰 JS 번들 경고는 남아 있다.
- 실제 Electron: 저장된 CT, MRI, AP, LAT-LT, LAT-RT 다섯 결과를 기존 protected Reader로 읽어 사본 생성 → 픽셀 가림 → 최종 승인 UI → DPAPI outbox → 암호화 전송 → 서버 검증 → 원격 PNG 열람까지 확인했다. 최종 승인 PNG와 원격 바이트 SHA-256 일치. 추론 재실행 없음.
- UI/회귀 증거: `outputs/publication-desktop-check/27a01fbc-0ffa-4cb9-a58f-6f6d8692331f/overlay-verification.json`, `remote-verification.json`, `verification.json`, `overlay-*.png`. 합성 IdP·로컬 시험 서버이며 실제 운영 배포 결과가 아니다.
- 격리 패키지 검증 위치: `work/overlay-package-check/verification.json`. 새 main 모듈 포함, 서버 코드/개인키 제외, 기존 서명 runtime·ASAR 무결성 검사. 기존 설치본과 `release/internal`을 교체하지 않았다.

남은 단계는 P7 Web/태블릿 Viewer·BFF와 P8 운영 IdP/HTTPS/ACL/암호화 볼륨·복구·부하·새 PC·실물 YubiKey·코드 서명 고객 설치본 검증이다. 본 구현을 전체 제품 출시 완료로 표시하지 않는다.

# EXMO Atlas 0.1.2 · 한국어 / English

창 오른쪽 위 **Language**에서 `한국어` 또는 `English`를 선택합니다.
변경 사항은 즉시 적용되며 다음 실행에도 유지됩니다. 기본값은 한국어입니다.
3D 데모에서도 같은 선택 메뉴를 사용할 수 있습니다.

## 적용 범위

- 분석 선택, 영상 등록/검토, 결과 목록, 측정값, QC 및 후처리 설명
- 3개 검사 비교, 3D 조작 안내, 접근성 이름과 툴팁
- 분류 안내, 분석 진행 단계, 입력 오류 및 기존 결과의 좌우 분류 설명
- 파일 선택창의 제목과 분석 날짜 표시

파일명, 검사 이름, 환자/영상 metadata, class ID, 모델 설정, 측정값은
번역하거나 변경하지 않습니다. 언어를 바꿔도 현재 화면의 비교 선택과
슬라이스가 유지됩니다. 번역은 앱에 포함되어 인터넷 연결이 필요 없습니다.
Windows가 제공하는 파일 선택창의 시스템 버튼은 Windows 표시 언어를 따릅니다.

## 구현 및 검증

`desktop/ui/locales/en.json`에 영어 문구를 보관하고, 한국어 문구를 기본 키로
사용합니다. `exmo.language` 설정만 로컬 저장소에 기록합니다. 저장소를 사용할
수 없는 경우에도 현재 실행 중 언어 전환은 가능합니다. 기존 분석 데이터와
Python 작업은 언어 설정에 의존하지 않습니다.

- `npm run test:language`: 번역 누락, 입력 오류 coverage, placeholder 일치 검사
- `scripts/validate-language-desktop.cjs`: 실제 Electron/preload/IPC와 별도 샘플
  저장소로 한국어↔영어 전환, 영어 접근성 문구/오류/파일 선택창, 3개 MRI 비교,
  슬라이스/측정값 보존, 작은 창 레이아웃을 확인합니다.
- 같은 검사의 `--reopen`: 새 프로세스에서 영어 설정 유지 확인
- 기존 `validate-imaging-desktop.cjs`: 한국어 상태에서 분석/3D 회귀 검사

언어 검사 fixture는 `outputs/language-check/userdata`에 준비된 샘플 결과를
사용하며, 실제 사용자 라이브러리와 분리됩니다. 실행 예:

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
.\node_modules\.bin\electron.cmd scripts/validate-language-desktop.cjs
.\node_modules\.bin\electron.cmd scripts/validate-language-desktop.cjs --reopen
```

`EXMO_TEST_APP_ROOT`를 설정하면 개발 소스 대신 패키징한 `resources/app.asar`를
검사합니다. 화면 증거와 보고서는 Git에서 제외된 `outputs/language-check`에
저장됩니다.

이 PC의 업데이트 설치 파일:
`release/language-0.1.2/EXMO-Atlas-Setup-0.1.2.exe`

기존 PC에서는 분석 엔진과 결과를 유지한 채 앱을 업데이트합니다. 다른 PC에서
이 설치 파일만 실행하면 분석 모델/환경까지 설치되지는 않으므로 별도의 이관
패키지 설치가 필요합니다.

## 2026-09-28 전수 점검

- 접근성 이름 `언어 / Language`가 영어 모드에도 남는 문제를 수정했습니다.
- 번역 241개, UI 소스 25개 파일의 한국어 literal 153곳, 백엔드 한국어
  literal 105곳을 검사합니다. 번역 호출 내부뿐 아니라 일반 JSX, 속성,
  조건부 문자열과 오류·경고·좌우 판정 사유·진행 상태까지 확인합니다.
- 실제 샘플의 CT, MRI 3개 비교, AP, LAT-LT, LAT-RT 결과/QC 화면과
  데모, 입력/검토, 파일 선택 제목, 작은 창, 재실행 후 설정을 검사합니다.
- 드문 실패 상태는 별도 테스트 프로세스에서 백엔드 문구 100개와 진행 단계
  5개를 주입하여 화면 번역을 확인합니다. 실제 실패나 추론 실행의 검증과는
  구분하며, 사용자 라이브러리나 production IPC 구현을 변경하지 않습니다.
- 언어 목록의 자국어 이름 `한국어`, 원본 파일명/metadata, Windows 시스템
  버튼은 영어로 치환하지 않습니다. 백엔드 parts의 `미분류` 이름은 저장 데이터이며
  현재 3D 화면은 해당 이름 대신 영어 구조명과 별도로 번역한 좌우 표기를 사용합니다.

자동 검사는 `title`, `aria-label`, `placeholder`, `alt`, `aria-description`,
`aria-valuetext`도 확인합니다. 소스 검사와 실행 검사의 범위 내에서 미번역을
확인하는 것으로, 모든 외부 파일/OS 오류 조합을 실제 발생시킨다는 의미는 아닙니다.

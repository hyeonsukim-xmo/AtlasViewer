# 캡스톤 / OpenSim 데이터 전달 작업 절차

최종 정리: 2026-10-21

## 요청의 의미

사용자가 “해당 데이터 만들어줘”, “캡스톤에 줬던 것처럼”, “다른 케이스도 전달용으로”
라고 하면 이 문서의 구성을 기본으로 적용한다. 이미 결정한 전달 항목, 보안 범위,
케이스 경로를 다시 질문하며 처음부터 설계하지 않는다.

이 절차의 결과는 다운로드 폴더의 전달 패키지와 ZIP이다. 외부 팀에 이메일·메시지를
보내거나 서버에 업로드하는 것은 별도 요청이 있을 때만 한다.

## 대상 케이스를 찾는 순서

1. 현재 대화에서 명시한 대상·제외 대상을 먼저 적용한다.
2. `work/capstone-handoff-registry.json`에서 해당 별칭, 분석 run, 전달본과
   private source audit 경로를 확인한다.
3. 해당 Desktop 프로필의 `imaging/runs/*/published.json`과 분석 이력을 대조한다.
   기본 개발 프로필은 `%APPDATA%\EXMO Atlas\imaging`, 내부 설치 프로필은
   `%APPDATA%\EXMO Atlas Internal\imaging`이다. 존재하는 프로필과 실제 결과를 확인한다.
4. 환자·Study·Series·run의 연결과 결과 파일을 확인한다. 폴더명이나 파일 수정 시각만으로
   다른 환자, 반복 분석 또는 retouch 결과를 동일 케이스로 취급하지 않는다.
5. 기록으로 후보가 하나로 정해지면 바로 진행한다. 기록이 없거나 서로 모순되어
   둘 이상으로 남을 때만 구체적인 후보를 제시해 한 번 확인한다.

“다른 케이스”라는 단어를 항상 최신 결과로 해석하지 않는다. 사용자가 “두 개 중
하나는 이상하고 하나는 괜찮다”고 지정했다면 그 비교 기록에서 괜찮다고 선택한
케이스를 찾는다. 사용자 선택은 임상 정확도 인증과 별개다.

## 현재 확정된 작업 맥락

| 구분 | 의미 | 로컬 기록 |
|---|---|---|
| 이전 MRI 전달 | MRI sample 3의 체적 크기를 참고한 near-symmetric 합성 예제 | `outputs/EXMO_OpenSim_Handoff_20261008/` |
| 이전 CT 전달 | 추가 분석 두 건 중 결과가 양호했던 이전 케이스. 전달 이름 `CT_REFERENCE_002` | `work/capstone-handoff-registry.json` |
| 최신 수정 CT 전달 | 사용자가 새로 지정한 수동 수정본. 전달 이름 `CT_REFERENCE_003_RETOUCHED` | 같은 registry의 해당 항목과 private source audit |

이 표는 현재 대화에서 선택한 대상의 기록이다. 앞으로 사용자가 다른 대상을 명시하면
그 선택을 우선한다. `CT_REFERENCE_002`를 모든 향후 요청의 고정 환자로 사용하지 않는다.
환자번호·DICOM UID·원본 파일 경로는 이 문서에 추가하지 않고 private registry에만 둔다.

## 동일한 전달본을 다시 요청한 경우

- registry의 폴더와 ZIP이 존재하는지 확인한다.
- 전달 폴더의 `verify.py` 또는 해당 패키지의 검증 코드를 실행한다.
- ZIP 내부 파일들이 검증된 폴더와 같은지 checksum으로 확인한다.
- 문제가 없으면 기존 폴더와 ZIP 링크를 바로 제공한다. 동일 자료를 만들기 위해
  재추론하거나 새로운 합성값을 생성하지 않는다.
- 사용자가 “수정된 최신본”을 요구한 경우에는 기존 전달 snapshot이 최신 수정본인지
  확인한다. 이전 GLB·이전 측정값에 새 retouch 파일명만 붙이지 않는다.

완료된 CT 폴더:

```text
%USERPROFILE%\Downloads\EXMO_OpenSim_CT002_Handoff_20261020
%USERPROFILE%\Downloads\EXMO_OpenSim_CT002_Handoff_20261020.zip
%USERPROFILE%\Downloads\EXMO_OpenSim_CT003_Retouched_Handoff_20261021
%USERPROFILE%\Downloads\EXMO_OpenSim_CT003_Retouched_Handoff_20261021.zip
```

현재 패키지 검사:

```powershell
python "$env:USERPROFILE\Downloads\EXMO_OpenSim_CT003_Retouched_Handoff_20261021\verify.py"
```

`verify.py`는 Python 표준 라이브러리만 사용한다. 재실행해도 원본이나 전달 파일을
수정하지 않는다.

## 새 케이스의 기본 전달 구성

| 파일 | 내용 |
|---|---|
| `observed_anatomy.json` | 기존 segmentation의 실제 측정값, 단위, 측정 정의, 좌우·미분류, 결측과 QC 상태 |
| `observed_measurements.csv` | 동일한 실제 측정값을 총합/좌/우/미분류로 비교하는 표 |
| `synthetic_anatomy.json` | 이전과 같은 연결 테스트용 합성 입력. 실측과 별도 파일·provenance로 구분 |
| `synthetic_parameters.csv` | 합성 체적·가정 FI·시나리오 배율 |
| `<case_alias>_reference.glb` | 바로 그 케이스에서 유래한 색상 포함 설명용 표면 |
| `README.md` | 한국어 파일 안내, 데이터와 가정 구분, 단위·결측·검증 범위 |
| `HANDOFF_EN.md` | 외부 구현 담당자에게 전달할 영어 연결 지침 |
| `verify.py` / `verification.json` | 수치·파일 대응·GLB·checksum 검사와 실제 수행 결과 |

전달 폴더 이름은 식별정보 없는 alias와 날짜를 사용한다. 같은 이름이 있으면
기존 폴더를 덮지 않고 새 버전 또는 시간을 붙인다. 폴더와 ZIP을 함께 만든다.
환자/원본/run 연결은 로컬 registry에 보관한다.

기존 형식을 재사용하되 특정 모달리티의 클래스 수, 결측 근육, 숫자 라벨 ID를
그대로 복사하지 않는다. 예를 들어 이전 MRI에서는 iliacus가 결측이지만 현재 CT에는
검출됐다. 이름·라벨 의미로 매핑하고 실제 검출 상태를 확인한다.

수동 수정본은 `.seg.nrrd`에 저장된 segment 이름·layer·label value를 읽는다.
CT003의 Pectineus 저장값은 6이며 모델의 원래 숫자 사전을 적용하면 오해석된다.
사용자가 만든 background나 빈 segment도 항목 기록에서 삭제하지 않는다.
`segment_inventory.csv`로 전체 원본 항목과 전달 항목을 대조한다.
CT003은 모든 55개 항목을 기록하고 검출된 근육·뼈만 설명용 GLB에 포함했다.
지방·background는 측정 표에 유지하며, 빈 항목에는 표면을 만들지 않는다.

`muscle_groups`는 원본 `structures`의 동일 해부학 이름 좌우를 집계한 대체 표현이다.
두 목록을 더해 중복 계산하지 않는다. Core 모델의 세부 라벨을 기존 aggregate나
다른 근육 이름으로 임의 대체하지 않고, OpenSim 대응이 불확실하면 그대로 표시한다.
수정 voxel에는 이전 모델의 entropy/TTA를 재사용하지 않는다.

## 실제값과 합성값의 기준

- 실제 체적·좌우값은 기존 결과 그대로 보존한다. 보기 좋게 비대칭을 줄이지 않는다.
- CT의 fat-range는 기존 구현의 `−190 ≤ HU ≤ −30` voxel 비율이다.
  MRI PDFF나 검증된 생물학적 FI로 이름을 바꾸지 않는다.
- MRI Water-only 입력 등에서 FI가 측정되지 않았다면 observed 값은 null이다.
  X-ray 투영 면적으로 3D 근육 체적을 만들어내지 않는다.
- 미검출/미확인 근육의 사용 가능한 체적은 null로 구분하고, voxel 수 0과
  실제 근육 부재 또는 0 근력을 혼동하지 않는다.
- 자동 좌우 미분류는 별도로 보존한다. 일부만 분류된 core를 임의로 반분하지 않는다.
- 같은 near-symmetric 예제를 요청하면 기존의 키 170 cm·체중 70 kg·환측 미지정,
  양측 평균 대비 체적 차이 약 2–4%, 가정 FI의 좌우 차이 0.8%p를 재사용한다.
  이것은 실제 대상자의 신체 정보나 정상 범위가 아니다.
- 기존 합성 FI는 근육별 평균 6–12%, 개별 값 5.6–12.4%의 예제이며 현재 CT의
  iliacus에는 평균 9%를 사용했다. 이전 예제에 없는 근육은 검토 없이 임의의 FI를
  추가하지 않는다. 필요한 가정을 명시하거나 null로 둔다.

Fmax의 절대값은 확정된 OpenSim 모델·actuator 매핑·근섬유 길이·specific tension이
없으면 null로 유지한다. 기존 제안서의 체적 기반 A 조건과 가정 FI를 한 번만 적용한
B 민감도 조건을 구분한다. CT fat-range를 검증된 힘 보정계수처럼 자동 대입하지 않는다.
전달물만 만들고 `.osim` 또는 보행 시뮬레이션까지 완료했다고 표현하지 않는다.

## 형상 및 보안 범위

허용된 설명용 GLB는 실제 segmentation 유래 형상임을 표시한다. 좌표축, 단위,
루트 scale, 자동 좌우/미분류 상태를 문서화한다. 합성 수치에 맞춰 형상이 변형된
것처럼 설명하지 않는다. 원본과 다른 케이스의 GLB를 대체 사용하지 않는다.

기본 전달물에서 원본 영상, voxel mask, MRB, 모델 가중치, 예측 확률, 환자번호,
Study/Series/SOP UID, 병원명, 원본 경로, private audit를 제외한다.
GLB가 역복원 불가능하거나 완전 익명화된 합성 형상이라고 보장하지 않는다.

## 생성·검증·기록

1. 기존 전달 파일과 생성 코드를 먼저 확인한다. 현재 CT 생성 기록은
   `work/build-ct002-capstone-handoff.py`, `work/build-ct003-capstone-handoff.py`와
   registry가 가리키는 private audit에 있다.
   이 스크립트들은 각각 해당 CT snapshot 전용이며 범용 exporter CLI가 아니다.
2. 기존 결과를 읽어 별도 출력 폴더에 구성한다. 추론·원본 retouch는 요청이 없는 한
   재실행하지 않는다. 원본 파일의 전후 해시를 대조한다.
3. 실제 측정값과 native geometry/voxel 수, 좌우 합계, 제공하는 HU/fat-range를 대조한다.
   geometry가 맞지 않으면 다른 영상의 값으로 채우지 않는다.
4. 합성 가정의 연산·결측·단위, CSV/JSON 일치를 검증한다.
5. GLB의 self-contained 구조, mesh/라벨 대응, 단위와 로더 파싱을 확인한다.
6. 제외 대상 데이터가 섞이지 않았는지 확인하고 checksum을 기록한다.
7. ZIP 무결성과 폴더 내용 일치를 확인한다. 다운로드 전달 경로와 private source
   연결을 registry에 남긴다.
8. 최종 답변은 **대상 케이스 + 폴더/ZIP 링크 + 포함 항목 + 미검증 범위**로 짧게 끝낸다.
   이미 확인된 정보를 다시 요청하거나 “가능하다”는 설명만 하고 멈추지 않는다.

`work/`와 `outputs/`는 Git 제외 경로다. 다른 PC에서는 로컬 registry·실제 분석 결과·
전달본이 자동 이동하지 않는다. 파일이 없으면 해당 PC의 분석 이력과 기존 전달본을
먼저 찾아 연결하고, 정말 찾을 수 없는 대상에 한해서만 필요한 정보를 요청한다.

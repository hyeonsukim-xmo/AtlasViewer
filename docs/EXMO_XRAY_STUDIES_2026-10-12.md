# X-ray 촬영 묶음 (Desktop)

## 동작

- 등록·선택·검토·결과 목록·홈 최근 분석을 환자·촬영일 단위로 묶는다.
- 한 촬영은 LT → AP → RT 순서다. 등록된 방향만 표시한다. 1장은 전체 폭, 2장은 2열, 3장은 3열이다.
- 미등록 방향은 상태 표시줄에 표시하며 큰 빈 Viewer를 만들지 않는다. 방향 미확인 입력은 검토 대상으로 남기고 추론에서 제외한다.
- 촬영 행 클릭으로 묶음 전체를 선택·해제한다. 개별 영상을 펼쳐 제외할 수 있고 검토 카드 우클릭도 해당 영상을 제외한다.
- 같은 방향이 여러 장이어도 버리지 않는다. 방향별 영상 전환을 제공하며 선택한 개별 영상마다 기존 엔진으로 추론한다.
- 미완료 영상만 분석하며 결과가 있는 inputId는 건너뛴다. 실패 재시도도 완료 결과를 건드리지 않는다.
- 일부 영상만 완료되어도 결과를 열 수 있다. 나머지가 완료되면 같은 촬영 묶음에 합류한다.
- 최대 3개 촬영을 선택해 같은 방향끼리 비교한다. 가능한 공통 방향부터 열며 해당 방향이 없는 촬영은 비교 영상 없음으로 표시한다.
- 측정·QC는 영상별로 유지한다. AP/LAT 면적을 합산하지 않는다. 해당 방향 모델의 비활성 label은 0 대신 해당 없음으로 표시하고 미검출 QC에서 제외한다.

## 식별과 기존 자료

자동 묶음은 환자번호 + 촬영일 + 발급기관(없으면 InstitutionName) 기준이다. 발급기관 정보가 없으면 StudyInstanceUID 범위에서만 묶는다. 환자번호 앞자리 0은 보존한다. 환자·촬영일이 없어도 동일 StudyInstanceUID는 함께 표시할 수 있다. 이 정보도 없으면 inputId별로 분리한다. 파일명이나 폴더명으로 환자를 추정하지 않는다.

DICOM의 PatientID, IssuerOfPatientID, InstitutionName, StudyDate, StudyInstanceUID, SeriesInstanceUID, SOPInstanceUID, AcquisitionTime을 보존한다. NRRD는 같은 이름의 header 항목이 있으면 읽는다. 기존 저장 결과에서 빠진 정보를 임의로 소급 생성하지 않는다.

정보가 없는 NRRD·기존 결과는 영상 또는 결과 묶음을 선택하고 **선택 영상의 촬영 정보 지정**에서 환자번호·기관·날짜를 입력한다. 이는 명시적인 사용자 지정이며 원본 header를 수정하지 않는다. 지정 정보는 Desktop userData/imaging/xray-studies.json에 inputId별로 원자적으로 저장되고 앱 재시작 후 다시 적용된다. 다른 컴퓨터로 결과를 옮길 때 이 파일도 imaging 저장소와 함께 옮긴다.

## 유지한 제한

X-ray DICOM은 등록·분류·묶음 검토가 가능하지만 기존 DICOM segmentation 복원 검증 제한은 유지한다. 현재 검증된 NRRD 추론 경로를 사용한다. 이번 변경은 모델 가중치·recipe·분할 색상·CT/MRI 처리 경로를 변경하지 않는다.

## 검증 (2026-10-12)

통과:

- `node scripts/validate-xray-studies.cjs`: 부분 촬영 7조합, LT/AP/RT 순서, 환자/기관/촬영일 분리, 중복 방향 보존, 공통 비교 방향, 완료 입력 제외, legacy LAT 비활성 label, IPC 입력 검증, 동시 지정 저장, 재시작 복원.
- `work/modality-integration/envs/ct/Scripts/python.exe -X utf8 scripts/validate-xray-study-metadata.py`: 합성 DICOM 식별 정보와 단일 projection 유지, 실제 NRRD 등록 경로의 metadata 추출, 파일명에서 신원 추정 금지. 모델을 로딩하지 않는다.
- 기존 early-results, atlas/interactions 검사.

실제 Desktop UI 자동 검사는 `scripts/validate-xray-studies-desktop.cjs`로 준비했다. 기존 library 대신 격리된 합성 fixture를 사용하며 추론하지 않는다. 이번 환경에서는 Electron GPU 자식 프로세스 시작 오류(0xC0000135)로 완료하지 못했다. 브라우저 대체 검증도 접근 거절되어 실행하지 않았다. 화면 클릭·배치·Overlay 실제 표시 검증은 미완료다.

실행: `npm run build:desktop` 후 `node_modules/.bin/electron.cmd scripts/validate-xray-studies-desktop.cjs`. 실제 모델 추론 성능과 결과 정확도는 이번 UI 변경에서 다시 측정하지 않았다.

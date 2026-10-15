# EXMO 보안 1단계: YubiKey 등록·인증 검증

- 작성일: 2026-10-15
- 앱 기준: `ac0998e` / `0.1.24`, 설계 기준 커밋: `d2c6700`
- 작업 브랜치: `feat/desktop-security`
- 설계: [Desktop 라이선스와 모델 보호](EXMO_DESKTOP_SECURITY_DESIGN.md)
- 현재 상태: 개발용 검증 도구 구현. 실물 동글이 연결되지 않아 하드웨어 통과 판정은 보류.

## 1. 이번 산출물과 경계

[yubikey_probe.py](../scripts/security/yubikey_probe.py)는 Windows 개발 PC에서 PIV 장치를 조회하고, 비어 있는 `9E`·`9D`에 키를 생성하며, 제조사 인증서와 실제 서명·ECDH 동작을 확인한다. 기존 Electron 앱·CT/MRI/AP/LAT 환경·분석 데이터에는 연결하지 않는다. 현재 고객 설치본에 라이선스 차단이나 모델 암호화가 적용된 것은 아니다.

| 명령 | 하는 일 | 동글 변경 |
| --- | --- | --- |
| `inventory` | 연결된 PIV 장치의 serial·firmware·form factor와 SDK 버전 조회 | 없음 |
| `provision --serial ...` | 사전 관리 설정과 제조사 F9 인증서를 검사한 후 빈 `9E`·`9D`에 서로 다른 P-256 키 생성 | 두 슬롯의 새 키 생성만 수행 |
| `enroll --serial ... --output ...` | 두 attestation chain·slot·serial·firmware·PIN/Touch 정책·현재 공개키를 검사하고 새 서명 및 ECDH 증명 수행, 공개 등록 기록 저장 | 없음 |
| `verify --serial ... --record ...` | 같은 검사를 다시 수행하고 기존 등록 기록의 두 공개키 지문과 대조 | 없음 |

이 도구의 JSON은 **서명되지 않은 개발용 공개 등록 기록**이다. EXMO 서버가 발급한 라이선스가 아니며, 파일만 수정해 앱 권한을 얻는 용도로 사용하면 안 된다. 매 검증은 기록 속 인증서·성공 표시를 신뢰하지 않고 연결된 장치에서 새 증명과 제조사 chain을 다시 확인한다. 실제 서버 등록에서는 기관 소유권·등록 허가·설치 키 증명을 추가해야 한다.

Python SDK로 하드웨어 API와 실패 조건을 먼저 검증한다. 배포용 공통 native 모듈, CNG/TPM 귀속, JWE 모델 키 봉투, 온라인 갱신·유예 상태, 모델·결과 암호화는 후속 단계다. 이번 ECDH 검사는 공유 비밀 일치 확인이며 JWE 봉투 검증이 아니다.

## 2. 환경 준비

지원 범위는 **Windows x64, CPython 3.12, 일반 YubiKey 5C Nano, firmware 5.4 이상**이다. AES256 관리 키와 슬롯/관리 metadata를 확인할 수 있는 범위로 제한한다. 실제 구매 동글의 펌웨어·무인 정책은 아직 검증하지 않았다. 다른 form factor·FIPS·구형 firmware를 자동으로 허용하지 않는다.

저장소 루트 PowerShell에서 실행한다. 기존 분석 환경에 패키지를 설치하지 않는다.

```powershell
python -m venv work/security-poc/env
& work/security-poc/env/Scripts/python.exe -m pip install --require-hashes --only-binary=:all: -r scripts/security/requirements.txt
& work/security-poc/env/Scripts/python.exe -m pip check
& work/security-poc/env/Scripts/python.exe -m unittest discover -s scripts/security -p 'test_*.py' -v
& work/security-poc/env/Scripts/python.exe scripts/security/yubikey_probe.py inventory
```

[requirements.txt](../scripts/security/requirements.txt)는 Windows/CPython 3.12용 19개 wheel의 버전과 SHA-256을 고정한다. 주요 버전은 `yubikey-manager 5.9.2`, `cryptography 50.0.2`, `pyOpenSSL 26.4.0`이다. `work/security-poc`는 Git 제외 대상이며 실행 환경·기록은 이 안에 둔다. 패키지나 인증서 갱신은 별도 검토 후 고정값을 변경한다.

정상적인 조회 결과가 비어 있으면 `hardware_not_connected`, 종료 코드 `2`를 반환한다. PC/SC context 생성 자체가 실패하면 `pcsc_unavailable`로 구분한다. 둘 다 하드웨어 검증 성공이 아니다. PIV/CCID 비활성화, 드라이버·Smart Card 서비스 문제로도 조회되지 않을 수 있으므로 ‘동글 미보유’라고 단정하지 않는다. `Get-Service SCardSvr`로 상태를 확인할 수 있으며 도구는 자동으로 USB 기능을 켜거나 Windows 서비스 설정을 바꾸지 않는다.

## 3. 전용 동글의 관리 설정

이 절차는 EXMO가 검증용으로 지정한 동글에서만 수행한다. 기존 업무용 동글을 초기화하지 않는다. 생성할 두 슬롯이 이미 사용 중이면 도구가 거부한다. `F9` 제조사 키·인증서는 어떤 단계에서도 변경하지 않는다.

등록 전에 기관의 승인된 비밀 저장소에서 **장치별로 다른 PIN·PUK·32바이트 AES256 관리 키**를 준비하고 복구 가능한 위치에 보관한다. 아래 제조사 CLI는 새 값을 숨김 프롬프트로 입력받는다. 비밀을 명령 인자·환경변수·스크립트·Git·스크린샷·로그에 넣지 않는다. `--generate` 옵션은 비밀을 콘솔에 출력할 수 있으므로 사용하지 않는다.

```powershell
# 실제 inventory에서 확인한 전용 동글 번호로 바꾼다.
$pivSerial = '전용_동글_SERIAL'
& work/security-poc/env/Scripts/ykman.exe --device $pivSerial piv access change-pin
& work/security-poc/env/Scripts/ykman.exe --device $pivSerial piv access change-puk
& work/security-poc/env/Scripts/ykman.exe --device $pivSerial piv access change-management-key --algorithm AES256
```

각 명령이 성공한 뒤 다음 명령으로 진행한다. 잘못된 PIN/PUK를 반복 시도하지 않는다. 원래 값을 모르는 장치는 자동 reset/unblock하지 말고 관리자에게 돌려보낸다. 이 도구는 기본 관리 값 여부를 검사할 수 있지만, 비밀의 무작위성·다른 장치와의 중복 여부·실제 백업 상태까지 증명하지 않는다.

## 4. 키 생성·등록·재검증

```powershell
& work/security-poc/env/Scripts/python.exe scripts/security/yubikey_probe.py provision --serial $pivSerial
& work/security-poc/env/Scripts/python.exe scripts/security/yubikey_probe.py enroll --serial $pivSerial --output work/security-poc/enrollment.json
& work/security-poc/env/Scripts/python.exe scripts/security/yubikey_probe.py verify --serial $pivSerial --record work/security-poc/enrollment.json
```

`provision`은 serial 재입력과 숨김 관리 키 입력을 요구한다. 기본 PIN·PUK·관리 키, 잠긴 PIN/PUK, AES256이 아닌 관리 키, 기존 슬롯 키/인증서가 있으면 생성 전에 거부한다. 키는 장치 내부에서 `PIN=Never`, `Touch=Never`로 생성한다. 이 정책은 소유 증명이며 사용자의 본인 확인은 아니다.

생성이 중단되면 일부 슬롯만 만들어졌을 수 있다. **무조건 재시도하거나 키를 지우지 않는다.** 남은 슬롯 상태를 확인하고 운영자가 복구 방법을 정한다. 기존 키가 있는 슬롯을 덮어쓰거나 자동으로 빈 상태로 복구하는 기능은 없다. `enroll`도 기존 출력 파일을 덮어쓰지 않으므로 재검증에는 `verify`를 사용한다.

인증서는 번들된 Yubico root 두 개와 intermediate 묶음으로 OpenSSL chain 검증을 수행한다. 임의 root 파일을 CLI 인자로 받거나 사용자 인증서를 trust store에 추가하지 않는다. 출처·수집일·파일/인증서 해시는 [sources.json](../scripts/security/trust/sources.json)에 기록했다. `.crt`는 LF 줄바꿈으로 고정하여 Windows checkout 뒤에도 파일 해시가 일치하도록 했다. 새로운 제조사 chain은 자동 다운로드로 신뢰하지 않는다.

장치 호출은 **배타적인 PC/SC 연결**을 사용하며, 실패 시 shared 연결로 바꾸거나 다른 YubiKey 관련 프로세스를 종료하지 않는다. 전체 하드웨어 helper는 60초 후 종료한다. timeout은 성공으로 처리하지 않으며 provisioning 중 timeout이면 부분 생성 여부를 확인해야 한다. 60초는 이 개발 도구의 안전한 대기 상한이며 서버 권한 정책을 확정한 값이 아니다.

공개 등록 기록에는 두 인증서·공개키 지문·serial·firmware·SDK 버전·검증 시각·서명/ECDH 소요 시간만 남긴다. 관리 키·장치 개인키·ECDH 공유 비밀·환자 데이터는 저장하지 않는다. Python 메모리의 비밀 완전 소거를 보장하지 않으며, 이 도구를 고객용 모델 보호 런타임으로 사용하지 않는다.

## 5. 실행 기록과 다음 통과 조건

2026-10-15 이 PC에서 확인한 결과:

| 확인 | 결과 |
| --- | --- |
| 전용 venv와 고정 패키지 설치 | 완료. 네 분석 환경과 분리 |
| 합성 인증서·가짜 세션 자동 검사 | 14개 통과: 체인·서명·ECDH·identity/policy·만료/replay·등록 불일치·덮어쓰기 방지·timeout·배타 연결·PC/SC 실패 구분 |
| 실제 SDK 장치 조회 | 배타 연결 경로에서 `pcsc_unavailable`, 종료 코드 `2`. `SCardSvr`는 Stopped/Automatic 상태. PnP 별도 조회에도 연결된 Yubico 장치 없음 |
| 실물 생성·attestation·서명·ECDH | 미실행: 연결된 PIV 동글 없음 |
| 장치 제거·재연결·절전 복귀·다중 프로세스 경합 | 실물 검사 대기 |
| CNG/TPM 귀속·모델 암호화·GPU 수치 회귀 | 이번 단계에 연결하지 않음 |

합성 테스트의 root는 메모리에서만 만들고 실제 CLI trust store에 넣지 않는다. 소프트웨어 테스트 통과를 ‘YubiKey 실물 통과’나 ‘고객 배포 보안 완료’로 집계하지 않는다.

초기 SDK 일반 조회는 context 오류를 비어 있는 장치 목록으로 숨겼다. 최종 도구는 이를 명시적 PC/SC 실패로 보고한다. 최초의 빈 목록 결과만으로 하드웨어 연결 경로가 정상이라고 판정하지 않는다.

실물이 연결되면 ① 전용 장치와 관리 값 확인 ② 빈 슬롯 생성 ③ enroll/verify ④ 분리·재연결·절전 후 verify ⑤ 잘못된 등록 기록과 다른 장치 거부 ⑥ 여러 도구가 동시에 접근할 때 안전한 실패와 잠금 해제 ⑦ 기본값·F9 불변 확인을 수행한다. 공개 등록 기록과 실제 시간을 남기고 확인된 firmware·SDK 조합을 승인 목록으로 고정한다. 그다음 온라인 활성화·lease·유예 검증으로 연결한다.

## 6. 제조사 근거

- [PIV attestation과 공식 CA 배포](https://developers.yubico.com/PIV/Introduction/PIV_attestation.html): 장치 생성 키·slot·정책 확인과 root 변경 근거.
- [PIV Python API](https://developers.yubico.com/yubikey-manager/API_Documentation/autoapi/yubikit/piv/index.html): 생성·metadata·서명·ECDH API. 설치된 5.9.2 소스도 대조했다.
- [PIN·Touch 정책](https://docs.yubico.com/yesdk/users-manual/application-piv/pin-touch-policies.html): 무인 동작 정책과 FIPS 차이.
- [Yubico PIV ECDH](https://docs.yubico.com/yesdk/users-manual/application-piv/key-agreement.html): 공유 비밀 생성과 모델 전체 복호화의 구분.

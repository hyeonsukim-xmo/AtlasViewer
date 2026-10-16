"""Read/sign/ECDH only. Runtime never provisions, replaces or exports a YubiKey private key."""
import json
import logging
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cryptography.hazmat.primitives import hashes, serialization
from smartcard.ExclusiveConnectCardConnection import ExclusiveConnectCardConnection
from ykman.pcsc import list_devices, ScardSmartCardConnection
from yubikit.piv import PivSession, SLOT, KEY_TYPE, PIN_POLICY, TOUCH_POLICY
from yubikit.support import read_info
from model_security import fields, decode, require, fingerprint
from model_envelope import encode, unwrap
from piv_support import check_device, check_admin_secrets, verify_record


def operate(message):
    operation = message['operation']
    require(operation in ('enroll', 'sign', 'unwrap'))
    fields(message, 'operation' if operation == 'enroll' else 'operation hardware message' if operation == 'sign' else 'operation hardware token context')
    devices = list(list_devices())
    selected = []
    for device in devices:
        with ScardSmartCardConnection(ExclusiveConnectCardConnection(device.reader.createConnection())) as connection:
            info = read_info(connection, device.pid)
            if operation == 'enroll' or info.serial == message['hardware']['serial']:
                selected.append(device)
    require(len(selected) == 1)
    device = selected[0]
    with ScardSmartCardConnection(ExclusiveConnectCardConnection(device.reader.createConnection())) as connection:
        info = read_info(connection, device.pid); check_device(info)
        session = PivSession(connection); check_admin_secrets(session)
        if operation == 'enroll':
            record = {'serial':info.serial, 'firmware':list(info.version),
                'factoryCertificate':session.get_certificate(SLOT.ATTESTATION).public_bytes(serialization.Encoding.PEM).decode(),
                'attestations':{f'{int(slot):02x}':session.attest_key(slot).public_bytes(serialization.Encoding.PEM).decode() for slot in (SLOT.CARD_AUTH, SLOT.KEY_MANAGEMENT)}}
        else:
            record = message['hardware']
            require(info.serial == record['serial'] and list(info.version) == record['firmware'])
        keys = verify_record(record, int(info.form_factor))
        for slot in (SLOT.CARD_AUTH, SLOT.KEY_MANAGEMENT):
            metadata = session.get_slot_metadata(slot)
            require(metadata.generated and metadata.key_type == KEY_TYPE.ECCP256 and metadata.pin_policy == PIN_POLICY.NEVER and metadata.touch_policy == TOUCH_POLICY.NEVER)
            require(fingerprint(metadata.public_key) == fingerprint(keys[f'{int(slot):02x}']))
        if operation == 'enroll': return record
        if operation == 'sign':
            data = decode(message['message']); require(len(data) <= 20000)
            require(data.startswith((b'EXMO/LICENSE/v2/dongle/', b'EXMO/MODEL-RUN/v1/dongle/')))
            signature = session.sign(SLOT.CARD_AUTH, KEY_TYPE.ECCP256, data, hashes.SHA256())
            from cryptography.hazmat.primitives.asymmetric import ec
            keys['9e'].verify(signature, data, ec.ECDSA(hashes.SHA256()))
            return encode(signature)
        return encode(unwrap(message['token'], lambda point:session.calculate_secret(SLOT.KEY_MANAGEMENT, point), message['context']))


if __name__ == '__main__':
    logging.disable(logging.CRITICAL)
    try:
        data = sys.stdin.buffer.readline(32769); require(len(data) <= 32768 and data.endswith(b'\n'))
        print(json.dumps({'value':operate(json.loads(data))}), flush=True)
    except Exception:
        print(json.dumps({'error':'등록된 YubiKey를 사용할 수 없습니다. 장치 연결과 PC/SC 서비스를 확인하세요.'}), flush=True)
        sys.exit(1)

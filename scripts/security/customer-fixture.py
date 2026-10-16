"""TEST ONLY. Synthetic keys are never trusted by production attestation verification."""
from datetime import datetime, timedelta, timezone
import ipaddress
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'desktop'))
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from model_envelope import wrap, unwrap, encode
from model_security import decode

def private(key): return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
def certificate(key, server=False):
    now = datetime.now(timezone.utc); name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'EXMO synthetic test only')])
    cert = x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1)).not_valid_after(now + timedelta(days=1))
    if server: cert = cert.add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), critical=False)
    return cert.sign(key, hashes.SHA256()).public_bytes(serialization.Encoding.PEM).decode()

message = json.loads(sys.stdin.buffer.readline())
if message['operation'] == 'fixture':
    keys = {name:ec.generate_private_key(ec.SECP256R1()) for name in ('9e', '9d', 'tls')}
    value = {'keys':{name:private(key) for name,key in keys.items()}, 'certificate':certificate(keys['tls'], True),
        'hardware':{'serial':123, 'firmware':[5, 7, 1], 'factoryCertificate':certificate(keys['9e']),
                    'attestations':{name:certificate(keys[name]) for name in ('9e', '9d')}}}
else:
    key = serialization.load_pem_private_key(message['key'].encode(), None)
    value = wrap(decode(message['plain'], 32), key.public_key(), message['context']) if message['operation'] == 'wrap' else encode(unwrap(message['token'], lambda point:key.exchange(ec.ECDH(), point), message['context']))
print(json.dumps(value))

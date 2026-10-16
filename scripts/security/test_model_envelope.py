import base64
import json
from pathlib import Path
import secrets
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'desktop'))
from cryptography.hazmat.primitives.asymmetric import ec
from model_envelope import wrap, unwrap, encode


class Envelope(unittest.TestCase):
    def test_hardware_callback_and_rejections(self):
        key = ec.generate_private_key(ec.SECP256R1())
        secret, context = secrets.token_bytes(32), 'installation-and-model-digest'
        token = wrap(secret, key.public_key(), context)
        called = []
        def agreement(point):
            called.append(point); return key.exchange(ec.ECDH(), point)
        self.assertEqual(unwrap(token, agreement, context), secret)
        self.assertEqual(len(called), 1)
        for index in range(5):
            parts = token.split('.')
            raw = bytearray(base64.urlsafe_b64decode(parts[index] + '=' * (-len(parts[index]) % 4)))
            raw[-1] ^= 1; parts[index] = encode(bytes(raw))
            with self.assertRaises(Exception): unwrap('.'.join(parts), agreement, context)
        with self.assertRaises(Exception): unwrap(token, agreement, 'wrong-installation')
        other = ec.generate_private_key(ec.SECP256R1())
        with self.assertRaises(Exception): unwrap(token, lambda point:other.exchange(ec.ECDH(), point), context)
        parts = token.split('.')
        header = json.loads(base64.urlsafe_b64decode(parts[0] + '=' * (-len(parts[0]) % 4)))
        header['alg'] = 'ECDH-ES'
        parts[0] = encode(json.dumps(header, separators=(',', ':')).encode())
        with self.assertRaises(Exception): unwrap('.'.join(parts), agreement, context)


if __name__ == '__main__': unittest.main()

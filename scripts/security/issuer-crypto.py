"""Issuer host only. Validate attestation and wrap a DEK; never returns a plaintext key."""
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'desktop'))
from model_security import fields, require, decode
from model_envelope import wrap
from piv_support import verify_record, fingerprint

if __name__ == '__main__':
    try:
        line = sys.stdin.buffer.readline(32769); require(len(line) <= 32768 and line.endswith(b'\n'))
        value = json.loads(line); operation = value['operation']
        require(operation in ('verify', 'wrap'))
        fields(value, 'operation hardware' if operation == 'verify' else 'operation hardware key context')
        keys = verify_record(value['hardware'])
        result = {name:fingerprint(key) for name,key in keys.items()} if operation == 'verify' else wrap(decode(value['key'], 32), keys['9d'], value['context'])
        print(json.dumps({'value':result}))
    except Exception:
        print(json.dumps({'error':'Hardware attestation or model envelope rejected'})); sys.exit(1)

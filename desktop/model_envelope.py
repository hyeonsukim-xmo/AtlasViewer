"""Restricted JWE ECDH-ES+A256KW / A256GCM, using cryptography primitives (RFC 7518)."""
import base64
import json
import secrets
import struct
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.concatkdf import ConcatKDFHash
from cryptography.hazmat.primitives.keywrap import aes_key_wrap, aes_key_unwrap
from model_security import canonical, decode, exact_json, fields, require


def encode(value): return base64.urlsafe_b64encode(value).decode().rstrip('=')


def kek(secret, apu, apv):
    # JWA 4.6.2: AlgorithmID, PartyUInfo, PartyVInfo, then SuppPubInfo (key size in bits).
    parts = [b'ECDH-ES+A256KW', apu, apv]
    other = b''.join(struct.pack('>I', len(p)) + p for p in parts) + struct.pack('>I', 256)
    return ConcatKDFHash(algorithm=hashes.SHA256(), length=32, otherinfo=other).derive(secret)


def wrap(plain, recipient, context):
    require(len(plain) == 32 and isinstance(recipient, ec.EllipticCurvePublicKey) and isinstance(recipient.curve, ec.SECP256R1))
    ephemeral = ec.generate_private_key(ec.SECP256R1()); numbers = ephemeral.public_key().public_numbers()
    apu, apv = secrets.token_bytes(32), context.encode()
    header = encode(canonical({'alg':'ECDH-ES+A256KW', 'enc':'A256GCM', 'typ':'EXMO-MODEL-KEY',
        'epk':{'kty':'EC', 'crv':'P-256', 'x':encode(numbers.x.to_bytes(32, 'big')), 'y':encode(numbers.y.to_bytes(32, 'big'))},
        'apu':encode(apu), 'apv':encode(apv)}).encode())
    key, nonce = secrets.token_bytes(32), secrets.token_bytes(12)
    wrapped = aes_key_wrap(kek(ephemeral.exchange(ec.ECDH(), recipient), apu, apv), key)
    ciphertext = AESGCM(key).encrypt(nonce, plain, header.encode())
    return '.'.join([header, encode(wrapped), encode(nonce), encode(ciphertext[:-16]), encode(ciphertext[-16:])])


def unwrap(token, calculate_secret, context):
    require(isinstance(token, str) and len(token) <= 4096)
    parts = token.split('.'); require(len(parts) == 5)
    header = exact_json(decode(parts[0]).decode())
    fields(header, 'alg enc typ epk apu apv')
    require(header['alg'] == 'ECDH-ES+A256KW' and header['enc'] == 'A256GCM' and header['typ'] == 'EXMO-MODEL-KEY')
    require(decode(header['apv']) == context.encode()); apu = decode(header['apu'], 32)
    epk = header['epk']; fields(epk, 'kty crv x y'); require(epk['kty'] == 'EC' and epk['crv'] == 'P-256')
    point = ec.EllipticCurvePublicNumbers(int.from_bytes(decode(epk['x'], 32), 'big'), int.from_bytes(decode(epk['y'], 32), 'big'), ec.SECP256R1()).public_key()
    shared = calculate_secret(point); require(len(shared) == 32)
    key = aes_key_unwrap(kek(shared, apu, decode(header['apv'])), decode(parts[1], 40))
    plain = AESGCM(key).decrypt(decode(parts[2], 12), decode(parts[3], 32) + decode(parts[4], 16), parts[0].encode())
    require(len(plain) == 32); return plain

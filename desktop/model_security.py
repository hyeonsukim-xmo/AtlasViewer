"""Worker admission and authenticated, memory-only model assets. No CLI key/file bypass."""
import base64
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import time
from contextlib import ExitStack
from types import SimpleNamespace

LIMIT = 512 * 1024
MAX_WEIGHTS = 1024 ** 3
PROTECTED_MRI = False  # Packaging fixes this to True; no runtime/environment switch.
MODEL_HEADER = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkVYTU8tTU9ERUwifQ'
LICENSE_HEADER = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkVYTU8tTElDRU5TRSJ9'
ENGINES = ('mri', 'ct', 'ap', 'lat_lt', 'lat_rt', 'xray-classifier')


def model_id(job):
    engine = {'AP': 'ap', 'LAT_LT': 'lat_lt', 'LAT_RT': 'lat_rt'}.get(job.get('route')) if job['analysis'] == 'xray' else job['analysis']
    require(engine in ENGINES)
    return engine


def package_file(engine):
    return 'model-package.json' if engine in ('mri', 'ct') else 'model-package-' + engine + '.json'


def require(ok):
    if not ok:
        raise ValueError('Protected model authorization or integrity check failed')


def fields(value, names):
    require(isinstance(value, dict) and set(value) == set(names.split()))


def digest(value):
    return hashlib.sha256(value).hexdigest()


def decode(value, size=None):
    require(isinstance(value, str) and 0 < len(value) <= LIMIT and re.fullmatch(r'[A-Za-z0-9_-]+', value))
    data = base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
    require(base64.urlsafe_b64encode(data).decode().rstrip('=') == value and (size is None or len(data) == size))
    return data


def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def exact_json(text):
    require(isinstance(text, str) and len(text.encode()) <= LIMIT)
    value = json.loads(text)
    require(canonical(value) == text)
    return value


def public(pem, kind):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec, rsa, ed25519
    require(isinstance(pem, str) and len(pem) < 2048 and 'PRIVATE' not in pem)
    key = serialization.load_pem_public_key(pem.encode())
    require((kind == 'ed25519' and isinstance(key, ed25519.Ed25519PublicKey)) or
            (kind == 'p256' and isinstance(key, ec.EllipticCurvePublicKey) and isinstance(key.curve, ec.SECP256R1)) or
            (kind == 'rsa' and isinstance(key, rsa.RSAPublicKey) and key.key_size == 3072 and key.public_numbers().e == 65537))
    return key


def fingerprint(key):
    from cryptography.hazmat.primitives import serialization
    return digest(key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo))


def signed(token, issuer, header):
    require(isinstance(token, str) and len(token) <= LIMIT)
    parts = token.split('.')
    require(len(parts) == 3 and parts[0] == header)
    issuer.verify(decode(parts[2], 64), (parts[0] + '.' + parts[1]).encode())
    return exact_json(decode(parts[1]).decode('utf8'))


def read(file, limit, stack=None):
    """Snapshot bytes; hold vendor code against replacement until this job finishes."""
    file = Path(file).absolute()
    for entry in [*file.parents, file]:
        info = entry.lstat()
        require(not entry.is_symlink() and not (getattr(info, 'st_file_attributes', 0) & 0x400))
    require(file.is_file() and file.stat().st_size <= limit)
    if os.name == 'nt':
        import msvcrt
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        create = kernel.CreateFileW
        create.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        create.restype = ctypes.c_void_p
        handle = create(str(file), 0x80000000, 1, None, 3, 0x00200000, None)
        require(handle != ctypes.c_void_p(-1).value)
        try:
            fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        except Exception:
            close = kernel.CloseHandle
            close.argtypes = [ctypes.c_void_p]
            close(handle)
            raise
        stream = os.fdopen(fd, 'rb')
    else:
        stream = file.open('rb')
    try:
        data = stream.read(limit + 1)
        require(len(data) <= limit)
        if stack is not None:
            stack.enter_context(stream)
            stream = None
        return data
    finally:
        if stream is not None:
            stream.close()


def load_policy():
    directory = Path(__file__).parent
    file = directory / 'model-policy.json'
    if not file.exists():
        require(not PROTECTED_MRI)
        return None  # Source development only; protected packages still require a policy.
    policy = json.loads(read(file, 8192))
    fields(policy, 'profile issuerPublicKey')
    require(policy['profile'] in ('internal', 'customer'))
    require(isinstance(policy['issuerPublicKey'], str) and len(policy['issuerPublicKey']) < 2048 and 'PRIVATE' not in policy['issuerPublicKey'])
    return policy


class ProtectedMRI:
    def __init__(self, root, issuer, engine='mri'):
        self.root, self.stack = Path(root).absolute(), ExitStack()
        try:
            document = json.loads(read(self.root / package_file(engine), LIMIT, self.stack))
            fields(document, 'token')
            self.model_digest = digest(document['token'].encode())
            value = signed(document['token'], issuer, MODEL_HEADER)
            legacy = engine == 'mri'
            fields(value, 'schema engine version loader size sha256 nonce cipherSha256 files' if legacy else 'schema engine version loader assets files')
            require(value['engine'] == engine and engine in ENGINES)
            require(value['schema'] == ('exmo-mri-package-v1' if legacy else 'exmo-model-package-v2'))
            require(value['loader'] == ('mri-safetensors-full6-v1' if legacy else engine + '-memory-v1'))
            require(isinstance(value['version'], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,80}', value['version']))
            assets = [dict(path='weights/final.safetensors', **{k: value[k] for k in ('size', 'sha256', 'nonce', 'cipherSha256')})] if legacy else value['assets']
            require(isinstance(assets, list) and 0 < len(assets) <= 10)
            self.assets = {}
            for asset in assets:
                fields(asset, 'path size sha256 nonce cipherSha256')
                name = asset['path']
                require(isinstance(name, str) and re.fullmatch(r'(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+', name) and not any(p in ('.', '..') for p in name.split('/')))
                require(name.lower() not in {p.lower() for p in self.assets} and type(asset['size']) is int and 0 < asset['size'] <= MAX_WEIGHTS)
                for field in ('sha256', 'cipherSha256'):
                    require(isinstance(asset[field], str) and re.fullmatch(r'[0-9a-f]{64}', asset[field]))
                decode(asset['nonce'], 12)
                self.assets[name] = asset
            require(isinstance(value['files'], list) and 0 < len(value['files']) <= 2000)
            names, total = set(), 0
            for record in value['files']:
                fields(record, 'path size sha256')
                name = record['path']
                require(isinstance(name, str) and re.fullmatch(r'(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+', name) and not any(p in ('.', '..') for p in name.split('/')))
                require(name.lower() not in names and type(record['size']) is int and 0 <= record['size'] <= 16 * 1024 ** 2)
                names.add(name.lower())
                total += record['size']
                require(total <= 64 * 1024 ** 2)
                data = read(self.root / name, record['size'], self.stack)
                require(len(data) == record['size'] and digest(data) == record['sha256'])
            require(not names.intersection(p.lower() for p in self.assets))
            if legacy:
                require({'run_inference.py', 'model_identity.json', 'runtime_hashes.json', 'weights/final.safetensors.manifest.json'} <= names)
            # Reject additional importable code and a leftover plaintext checkpoint in this delivery.
            for file in self.root.rglob('*'):
                require(not file.is_symlink())
                if file.is_file() and file.suffix in ('.py', '.pyc', '.pyd', '.pth', '.safetensors', '.npz'):
                    require(file.relative_to(self.root).as_posix().lower() in names and file.suffix not in ('.pyc', '.pyd', '.pth', '.safetensors', '.npz'))
            self.value, self.key, self.engine = value, None, engine
        except Exception:
            self.close()
            raise

    def weights(self, path):
        require(self.key is not None)
        name = Path(path).absolute().relative_to(self.root).as_posix()
        require(name in self.assets)
        asset = self.assets[name]
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        encrypted = read(self.root / (name + '.enc'), asset['size'] + 16)
        require(len(encrypted) == asset['size'] + 16 and digest(encrypted) == asset['cipherSha256'])
        # AESGCM verifies the tag before the safetensors parser receives any plaintext.
        aad = 'EXMO/MRI/v1/' + asset['sha256'] if self.engine == 'mri' else 'EXMO/MODEL/v2/' + self.engine + '/' + name
        plain = AESGCM(bytes(self.key)).decrypt(decode(asset['nonce'], 12), encrypted, aad.encode())
        require(len(plain) == asset['size'] and digest(plain) == asset['sha256'])
        return SimpleNamespace(value=plain, sha256=asset['sha256'])

    def close(self):
        if getattr(self, 'key', None) is not None:
            self.key[:] = b'\0' * len(self.key)
            self.key = None
        self.stack.close()
        # shortcut: Python/Torch can retain copies; native loader and dump hardening precede customer release.


class ModelGuard:
    def __init__(self, policy, engine_root):
        self.policy, self.engine_root = policy, Path(engine_root)
        self.root = self.model_root('mri')
        self._issuer = None
        self.pending = {}

    @property
    def issuer(self):
        # CT/AP/LAT keep their existing environments; only MRI needs cryptography in this stage.
        if self.policy and self._issuer is None:
            self._issuer = public(self.policy['issuerPublicKey'], 'ed25519')
        return self._issuer

    def model_root(self, engine):
        require(engine in ENGINES)
        return self.engine_root / 'packages' / ('EXMO_MRI' if engine == 'mri' else 'EXMO_CT' if engine == 'ct' else 'EXMO_XRAY')

    def challenge(self, run_id, engine='mri'):
        require(self.issuer is not None and re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', run_id))
        self.pending = {k: v for k, v in self.pending.items() if v[2] > time.monotonic()}
        require(run_id not in self.pending and len(self.pending) < 2)
        package = json.loads(read(self.model_root(engine) / package_file(engine), LIMIT))
        fields(package, 'token')
        require(signed(package['token'], self.issuer, MODEL_HEADER)['engine'] == engine)
        nonce, model_digest = secrets.token_urlsafe(32), digest(package['token'].encode())
        self.pending[run_id] = nonce, model_digest, time.monotonic() + 60, engine
        return {'nonce': nonce, 'modelDigest': model_digest}

    def admit(self, run_id, job, authorization):
        started = time.monotonic()
        require(self.issuer is not None)
        pending = self.pending.pop(run_id, None)
        engine = model_id(job)
        require(pending is not None and time.monotonic() < pending[2] and pending[3] == engine)
        customer = self.policy['profile'] == 'customer'
        fields(authorization, 'lease access installationPublicKey modelKeyPublicKey message signature key' + (' donglePublicKey dongleSignature' if customer else ''))
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec
        signing = public(authorization['installationPublicKey'], 'p256')
        signing.verify(decode(authorization['signature']), ('EXMO/MODEL-RUN/v1/' + authorization['message']).encode(), ec.ECDSA(hashes.SHA256()))
        claims = exact_json(authorization['message'])
        fields(claims, 'schema runId engine nonce modelDigest jobDigest leaseDigest keyDigest iat exp')
        require(claims['schema'] == 'exmo-model-run-v1' and claims['runId'] == run_id and claims['engine'] == engine)
        require(claims['nonce'] == pending[0] and claims['modelDigest'] == pending[1])
        require(claims['jobDigest'] == digest(canonical(job).encode()) and claims['leaseDigest'] == digest(authorization['lease'].encode()))
        lease = signed(authorization['lease'], self.issuer, LICENSE_HEADER)
        fields(lease, 'iss aud kind binding nonce iat exp renewAfter revision sequence decision engines modelDigests')
        require(isinstance(lease['modelDigests'], list) and len(lease['modelDigests']) <= 6 and pending[1] in lease['modelDigests'])
        require(lease['iss'] == 'exmo-license-v2' and lease['aud'] == 'exmo-desktop-v2' and lease['kind'] == 'lease' and lease['decision'] == 'allow')
        binding = lease['binding']
        fields(binding, 'profile licenseId installationId installationKey' + (' dongleKey agreementKey' if customer else ''))
        require(binding['profile'] == self.policy['profile'] and binding['installationKey'] == fingerprint(signing))
        if customer:
            dongle = public(authorization['donglePublicKey'], 'p256')
            require(fingerprint(dongle) == binding['dongleKey'])
            dongle.verify(decode(authorization['dongleSignature']), ('EXMO/MODEL-RUN/v1/dongle/' + authorization['message']).encode(), ec.ECDSA(hashes.SHA256()))
        for name in ('iat', 'exp', 'renewAfter', 'revision', 'sequence'):
            require(type(lease[name]) is int and lease[name] >= 0)
        require(lease['revision'] > 0 and lease['sequence'] > 0 and lease['iat'] < lease['renewAfter'] <= lease['exp'] <= lease['iat'] + 7 * 86400)
        entitled = any(e in lease['engines'] for e in ('ap', 'lat')) if engine == 'xray-classifier' else ('lat' if engine.startswith('lat_') else engine) in lease['engines']
        require(isinstance(lease['engines'], list) and entitled and set(lease['engines']) <= {'ct', 'mri', 'ap', 'lat'})
        require(type(claims['iat']) is int and type(claims['exp']) is int and lease['iat'] <= claims['iat'] < claims['exp'] <= min(claims['iat'] + 60, lease['exp']))
        require(claims['iat'] - 2 <= time.time() < claims['exp'])
        access = signed(authorization['access'], self.issuer, MODEL_HEADER)
        fields(access, 'schema binding modelDigest recipient ' + ('jwe' if customer else 'wrappedKey'))
        require(access['schema'] == ('exmo-model-access-v2' if customer else 'exmo-model-access-v1') and access['binding'] == binding and access['modelDigest'] == pending[1])
        require(access['recipient'] == fingerprint(public(authorization['modelKeyPublicKey'], 'rsa')))
        if customer:
            require(isinstance(access['jwe'], str) and len(access['jwe']) < 8192 and len(access['jwe'].split('.')) == 5)
        else:
            decode(access['wrappedKey'], 384)
        key = bytearray(decode(authorization['key'], 32))
        try:
            require(digest(key) == claims['keyDigest'])
            model = ProtectedMRI(self.model_root(engine), self.issuer, engine)
            if model.model_digest != pending[1] or time.time() >= claims['exp']:
                model.close()
                require(False)
            model.key = bytearray(key)
            model.admission_seconds = time.monotonic() - started
            return model
        finally:
            key[:] = b'\0' * len(key)

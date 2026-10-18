"""Read an authenticated fixed result and export only encrypted, metadata-free labels."""
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import numpy as np
import SimpleITK as sitk
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from model_security import require

CHUNK = 1024 * 1024


def export(message, read_snapshot, make_mesh):
    p = read_snapshot(message['result'], message['variant'], make_mesh, adopt=True, verify_recipe=False)
    require(p is not None and p['_snapshot']['snapshotDigest'] == message['snapshotDigest'])
    image = sitk.ReadImage(p['mask'])
    require(image.GetDimension() == 3)
    labels = sitk.GetArrayViewFromImage(image)
    require(np.issubdtype(labels.dtype, np.integer) and labels.min() >= 0 and labels.max() <= 65535)
    require(labels.size * 2 <= 1024 ** 3)
    geometry = dict(size=list(image.GetSize()), spacing=list(image.GetSpacing()), origin=list(image.GetOrigin()), direction=list(image.GetDirection()))
    key = secrets.token_bytes(32)
    public = serialization.load_pem_public_key(message['publicKey'].encode())
    require(isinstance(public, rsa.RSAPublicKey) and public.key_size == 3072)
    wrapped = public.encrypt(key, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    target = Path(message['destination']).absolute()
    require(target.is_dir())
    for entry in [target, *target.parents]:
        require(not entry.is_symlink() and not (getattr(entry.lstat(), 'st_file_attributes', 0) & 0x400))
    scope, identity, attempt = message['scope'], message['identity'], message['attemptId']
    prefix = ['EXMO/PUBLICATION/v1', scope['orgId'], scope['workspaceId'], identity['originStoreId'], identity['originResultId'], identity['analysisRevision'], attempt, 'mask']
    digest, parts, total = hashlib.sha256(), [], 0
    flat = labels.reshape(-1)
    for start in range(0, flat.size, CHUNK // 2):
        block = flat[start:start + CHUNK // 2].astype('<u2', copy=False).tobytes()
        digest.update(block); total += len(block)
        nonce = secrets.token_bytes(12)
        aad = json.dumps(prefix + [len(parts)], ensure_ascii=False, separators=(',', ':')).encode()
        encrypted = nonce + AESGCM(key).encrypt(nonce, block, aad)
        with (target / f'{len(parts)}.part').open('xb') as stream:
            stream.write(encrypted); stream.flush(); os.fsync(stream.fileno())
        parts.append(dict(sha256=hashlib.sha256(encrypted).hexdigest(), bytes=len(encrypted)))
    return dict(geometry=geometry, artifact=dict(kind='mask', sha256=digest.hexdigest(), bytes=total,
                wrappedKey=base64.urlsafe_b64encode(wrapped).decode().rstrip('='), parts=parts))

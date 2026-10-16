"""Authenticated seekable artifacts. Each file has a fresh key; no plaintext staging file."""
import builtins
import hashlib
import io
import os
from pathlib import Path
import re
import secrets
import struct
from contextlib import nullcontext

MAGIC = b'EXMOAF01'
END = b'EXMOEND1'
CHUNK = 4 * 1024 ** 2
HEADER = 88
FOOTER = 40
MAX_SIZE = 8 * 1024 ** 3
_open, _io_open, _os_open, _fdopen, _os_close = builtins.open, io.open, os.open, os.fdopen, os.close
_store = None
_measure = lambda stage: nullcontext()


def measure_with(callback):
    global _measure
    _measure = callback


def encrypt(cipher, nonce, plain, aad):
    with _measure('artifact_encrypt'):
        return cipher.encrypt(nonce, plain, aad)


def decrypt(cipher, nonce, ciphertext, aad):
    with _measure('artifact_decrypt'):
        return cipher.decrypt(nonce, ciphertext, aad)


def require(value):
    if not value:
        raise ValueError('Encrypted artifact is invalid or incomplete')


class Writer(io.RawIOBase):
    def __init__(self, stream, master):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        self.stream, self.buffer, self.total, self.count = stream, bytearray(), 0, 0
        key, file_id, self.prefix, nonce = secrets.token_bytes(32), secrets.token_bytes(16), secrets.token_bytes(4), secrets.token_bytes(12)
        self.header = MAGIC + file_id + self.prefix + nonce + encrypt(AESGCM(master), nonce, key, MAGIC + file_id)
        self.cipher = AESGCM(key)
        self.stream.write(self.header)
    def writable(self): return True
    def fileno(self): return self.stream.fileno()
    def tell(self): return self.total + len(self.buffer)
    def write(self, data):
        require(not self.closed)
        data = memoryview(data).cast('B')
        require(self.tell() + len(data) <= MAX_SIZE)
        length = len(data)
        while data:
            count = min(CHUNK - len(self.buffer), len(data))
            self.buffer.extend(data[:count]); data = data[count:]
            if len(self.buffer) == CHUNK: self._block()
        return length
    def _block(self):
        counter = struct.pack('>Q', self.count)
        self.stream.write(encrypt(self.cipher, self.prefix + counter, bytes(self.buffer), self.header + counter + struct.pack('>I', len(self.buffer))))
        self.total += len(self.buffer); self.count += 1
        self.buffer[:] = b'\0' * len(self.buffer); self.buffer.clear()
    def flush(self):
        if not self.closed and not self.stream.closed: self.stream.flush()
    def close(self):
        if self.closed: return
        try:
            if self.buffer: self._block()
            footer = END + struct.pack('>QQ', self.total, self.count)
            self.stream.write(footer + encrypt(self.cipher, self.prefix + b'\xff' * 8, b'', self.header + footer))
            self.stream.flush(); os.fsync(self.stream.fileno())
        finally:
            super().close(); self.stream.close(); self.cipher = None


class Reader(io.RawIOBase):
    def __init__(self, stream, master, allow_fileno=False):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        self.stream, self.position, self.cached, self.block = stream, 0, -1, b''
        self.allow_fileno = allow_fileno
        try:
            self.header = stream.read(HEADER); require(len(self.header) == HEADER and self.header[:8] == MAGIC)
            self.prefix = self.header[24:28]
            key = decrypt(AESGCM(master), self.header[28:40], self.header[40:], self.header[:24])
            self.cipher = AESGCM(key)
            stream.seek(-FOOTER, io.SEEK_END); footer = stream.read(FOOTER)
            require(len(footer) == FOOTER and footer[:8] == END)
            decrypt(self.cipher, self.prefix + b'\xff' * 8, footer[24:], self.header + footer[:24])
            self.size, count = struct.unpack('>QQ', footer[8:24])
            require(self.size <= MAX_SIZE and count == (self.size + CHUNK - 1) // CHUNK)
            require(stream.tell() == HEADER + self.size + count * 16 + FOOTER)
        except Exception:
            stream.close(); raise
    def readable(self): return True
    def seekable(self): return True
    def fileno(self):
        # NumPy must use decrypted reads, never fromfile/mmap on the ciphertext descriptor.
        if not self.allow_fileno: raise io.UnsupportedOperation('Encrypted stream has no native read descriptor')
        return self.stream.fileno()
    def tell(self): return self.position
    def seek(self, offset, whence=io.SEEK_SET):
        require(whence in (io.SEEK_SET, io.SEEK_CUR, io.SEEK_END))
        position = offset + (self.position if whence == io.SEEK_CUR else self.size if whence == io.SEEK_END else 0)
        require(position >= 0); self.position = position; return position
    def readinto(self, target):
        target = memoryview(target).cast('B'); written = 0
        while target and self.position < self.size:
            index, offset = divmod(self.position, CHUNK)
            if self.cached != index:
                length = min(CHUNK, self.size - index * CHUNK)
                self.stream.seek(HEADER + index * (CHUNK + 16))
                ciphertext = self.stream.read(length + 16); require(len(ciphertext) == length + 16)
                counter = struct.pack('>Q', index)
                self.block = decrypt(self.cipher, self.prefix + counter, ciphertext, self.header + counter + struct.pack('>I', length))
                self.cached = index
            count = min(len(target), len(self.block) - offset)
            target[:count] = self.block[offset:offset + count]
            self.position += count; written += count; target = target[count:]
        return written
    def close(self):
        if self.closed: return
        self.block, self.cipher = b'', None
        self.stream.close(); super().close()


class Store:
    def __init__(self, root, key):
        require(len(key) == 32)
        self.root, self.key, self.descriptors = Path(os.path.abspath(root)), bytes(key), set()
    def managed(self, file):
        if not isinstance(file, (str, bytes, os.PathLike)): return False
        file = Path(os.path.abspath(os.fsdecode(file)))
        if self.root not in file.parents: return False
        return bool(re.search(r'\.(?:nrrd|nii|npy|npz)(?:[.\-_]|$)', file.name.lower()))
    def encrypted(self, file):
        if not self.managed(file) or not Path(file).is_file(): return False
        with _open(file, 'rb') as stream: return stream.read(8) == MAGIC
    def anchor(self, file):
        file = Path(os.path.abspath(file))
        require(self.root in file.parents)
        for entry in [file, *file.parents]:
            if entry.exists():
                stat = entry.lstat()
                require(not entry.is_symlink() and not (getattr(stat, 'st_file_attributes', 0) & 0x400))
    def open(self, file, mode='r', buffering=-1, encoding=None, errors=None, newline=None, closefd=True, opener=None):
        if not self.managed(file):
            return _open(file, mode, buffering, encoding, errors, newline, closefd, opener)
        self.anchor(file)
        require('b' in mode and 'a' not in mode and opener is None)
        if mode in ('wb', 'xb', 'w+b', 'wb+'):
            # ZipFile probes seek support, then uses its forward-only archive format.
            return Writer(_open(file, mode.replace('+', '')), self.key)
        require(mode in ('rb', 'r+b', 'rb+'))
        if not self.encrypted(file):
            return _open(file, mode)  # Existing source/development results stay readable; never rewrite them automatically.
        return io.BufferedReader(Reader(_open(file, mode), self.key, allow_fileno='+' in mode), buffer_size=65536)
    def atomic_write(self, path, payload, *, mode=0o640, overwrite=False):
        path = Path(path)
        if not self.managed(path): raise ValueError('Artifact outside storage root')
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name('.' + path.name + '.' + secrets.token_hex(16) + '.tmp')
        try:
            with self.open(temporary, 'xb') as stream: stream.write(payload)
            with self.open(temporary, 'rb') as stream:
                require(hashlib.file_digest(stream, 'sha256').digest() == hashlib.sha256(payload).digest())
            if overwrite: os.replace(temporary, path)
            else: os.link(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
        return path


def install(root, key):
    """The worker owns one store. Hooks only apply to its private imaging artifact paths."""
    global _store
    require(_store is None)
    store = _store = Store(root, key)
    builtins.open = io.open = store.open
    def os_open(file, flags, mode=0o777, *, dir_fd=None):
        if store.managed(file) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT):
            store.anchor(file)
            descriptor = _os_open(file, flags, mode, dir_fd=dir_fd)
            store.descriptors.add(descriptor)
            return descriptor
        return _os_open(file, flags, mode, dir_fd=dir_fd)
    def fdopen(fd, mode='r', *args, **kwargs):
        if fd in store.descriptors:
            store.descriptors.remove(fd); require(mode == 'wb')
            return Writer(_fdopen(fd, mode), store.key)
        return _fdopen(fd, mode, *args, **kwargs)
    def close(fd):
        store.descriptors.discard(fd); return _os_close(fd)
    os.open, os.fdopen, os.close = os_open, fdopen, close
    return store


def current(): return _store


def initialize(message):
    import base64
    require(set(message) <= {'operation', 'root', 'key', 'id', 'requestId'} and isinstance(message.get('root'), str))
    encoded = message.pop('key')
    require(isinstance(encoded, str) and re.fullmatch('[A-Za-z0-9_-]{43}', encoded))
    key = base64.urlsafe_b64decode(encoded + '=')
    store = install(message['root'], key)
    install_image_io(store)


def install_image_io(store):
    """Native image libraries need stream adapters; unchanged geometry is checked on readback."""
    import gzip
    try:
        import nibabel as nib
    except ModuleNotFoundError as error:
        if error.name != 'nibabel': raise
        nib = None  # MRI writes NRRD only; retain the existing dependency set.
    import nrrd
    import numpy as np
    try:
        import SimpleITK as sitk
    except ModuleNotFoundError as error:
        if error.name != 'SimpleITK': raise
        sitk = None  # AP only writes NRRD through pynrrd; it has no ITK dependency.
    nib_load, nib_save = (nib.load, nib.save) if nib else (None, None)
    sitk_read, sitk_write = (sitk.ReadImage, sitk.WriteImage) if sitk else (None, None)
    nrrd_read = nrrd.read
    def read_nrrd(file, custom_field_map=None, index_order='F'):
        if not store.encrypted(file): return nrrd_read(file, custom_field_map, index_order)
        with store.open(file, 'rb') as stream:
            header = nrrd.read_header(stream, custom_field_map)
            require('data file' not in header and int(np.prod(header['sizes'], dtype=object)) <= 256_000_000)
            if header['encoding'] in ('raw', 'ASCII', 'ascii', 'text', 'txt'):
                stream = io.BytesIO(stream.read())
            return nrrd.read_data(header, stream, index_order=index_order), header
    def load_nifti(file, *args, **kwargs):
        require(nib is not None)
        if not store.encrypted(file): return nib_load(file, *args, **kwargs)
        with store.open(file, 'rb') as stream:
            payload = stream.read()
        if str(file).endswith('.gz'): payload = gzip.decompress(payload)
        require(len(payload) <= MAX_SIZE)
        return nib.Nifti1Image.from_bytes(payload)
    def save_nifti(image, file, *args, **kwargs):
        if not store.managed(file): return nib_save(image, file, *args, **kwargs)
        payload = image.to_bytes()
        if str(file).endswith('.gz'): payload = gzip.compress(payload, mtime=0)
        store.atomic_write(file, payload, overwrite=True)
    def read_image(file, *args, **kwargs):
        if not store.encrypted(file): return sitk_read(file, *args, **kwargs)
        if '.nii' in str(file):
            ni = load_nifti(file)
            array = np.asarray(ni.dataobj)
            affine = np.diag([-1., -1., 1., 1.]) @ ni.affine
            basis, origin = affine[:3, :3], affine[:3, 3]
        else:
            array, header = read_nrrd(str(file), index_order='F')
            # Match SimpleITK's zero origin when the optional NRRD field is absent.
            basis, origin = np.asarray(header['space directions']).T, np.asarray(header.get('space origin', [0., 0., 0.]))
            space = header.get('space')
            require(space in ('left-posterior-superior', 'right-anterior-superior', 'LPS', 'RAS'))
            if space in ('right-anterior-superior', 'RAS'):
                transform = np.diag([-1., -1., 1.]); basis, origin = transform @ basis, transform @ origin
        require(array.ndim == 3 and basis.shape == (3, 3))
        spacing = np.linalg.norm(basis, axis=0)
        require(np.isfinite(basis).all() and np.isfinite(origin).all() and (spacing > 0).all())
        image = sitk.GetImageFromArray(np.ascontiguousarray(array.transpose(2, 1, 0)))
        image.SetSpacing(tuple(spacing)); image.SetOrigin(tuple(origin)); image.SetDirection(tuple((basis / spacing).ravel()))
        pixel_type = args[0] if args else kwargs.get('outputPixelType', sitk.sitkUnknown)
        return sitk.Cast(image, pixel_type) if pixel_type != sitk.sitkUnknown else image
    def write_image(image, file, *args, **kwargs):
        if not store.managed(file): return sitk_write(image, file, *args, **kwargs)
        require('.nrrd' in str(file) and image.GetDimension() == 3 and image.GetNumberOfComponentsPerPixel() == 1)
        array = sitk.GetArrayFromImage(image).transpose(2, 1, 0)
        basis = np.asarray(image.GetDirection()).reshape(3, 3) @ np.diag(image.GetSpacing())
        header = {'space':'left-posterior-superior', 'space directions':basis.T, 'space origin':image.GetOrigin(),
                  'kinds':['domain'] * 3, 'encoding':'gzip'}
        payload = io.BytesIO(); nrrd.write(payload, array, header, index_order='F')
        store.atomic_write(file, payload.getvalue(), overwrite=True)
        back = read_image(file)
        require(back.GetSize() == image.GetSize() and np.array_equal(sitk.GetArrayFromImage(back), sitk.GetArrayFromImage(image)))
        require(np.allclose(back.GetSpacing(), image.GetSpacing(), rtol=0, atol=1e-10) and
                np.allclose(back.GetOrigin(), image.GetOrigin(), rtol=0, atol=1e-10) and
                np.allclose(back.GetDirection(), image.GetDirection(), rtol=0, atol=1e-10))
    nrrd.read = read_nrrd
    if nib:
        nib.load, nib.save = load_nifti, save_nifti
    if sitk:
        sitk.ReadImage, sitk.WriteImage = read_image, write_image

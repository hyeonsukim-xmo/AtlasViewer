"""Verify the supplied private deliveries and extract them locally, without running bundle code."""
from __future__ import annotations
import argparse
import hashlib
import json
import shutil
import stat
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

ARCHIVES = {
    "EXMO_CT.zip": "bf5254a262341e65efb17555ef1970102fe41707d139311eac5a245ac603146f",
    "EXMO_MRI.tar.gz": "efb93e39030531ac24f234cb2c4c4d2be40e94d0695b592a73d4dec65e912616",
    "EXMO_XRAY.zip": "d16bf13062e30d421703367c96e54f2552f030e07467cf843095d63bf4865b52",
}

def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def destination(root, name):
    parts = PurePosixPath(name).parts
    if not parts or name.startswith("/") or any(p in ("..", ".") for p in parts) or "\\" in name or ":" in name:
        raise ValueError("Unsafe archive member")
    target = root.joinpath(*parts).resolve()
    if not target.is_relative_to(root):
        raise ValueError("Archive member escapes the destination")
    return target

def prepare(source, target):
    target = target.resolve()
    target.mkdir(parents=True, exist_ok=True)
    (target.parent / "verified-packages.json").unlink(missing_ok=True)
    report = {}
    for filename, expected in ARCHIVES.items():
        archive = source / filename
        print(json.dumps({"stage": "checksum", "archive": filename}), flush=True)
        actual = digest(archive)
        if actual != expected:
            raise ValueError("Archive checksum mismatch: " + filename)
        if filename.endswith(".zip"):
            with zipfile.ZipFile(archive) as package:
                members = package.infolist()
                for member in members:
                    if stat.S_ISLNK(member.external_attr >> 16):
                        raise ValueError("Archive links are prohibited")
                    path = destination(target, member.filename)
                    if member.is_dir():
                        path.mkdir(parents=True, exist_ok=True)
                    else:
                        path.parent.mkdir(parents=True, exist_ok=True)
                        with package.open(member) as src, path.open("wb") as dst:
                            shutil.copyfileobj(src, dst, 8 * 1024 * 1024)
        else:
            with tarfile.open(archive, "r:gz") as package:
                for member in package:
                    path = destination(target, member.name)
                    if member.isdir():
                        path.mkdir(parents=True, exist_ok=True)
                    elif member.isfile():
                        path.parent.mkdir(parents=True, exist_ok=True)
                        with package.extractfile(member) as src, path.open("wb") as dst:
                            shutil.copyfileobj(src, dst, 8 * 1024 * 1024)
                    else:
                        raise ValueError("Archive links/special files are prohibited")
        report[filename] = actual
        print(json.dumps({"stage": "extracted", "archive": filename}), flush=True)
    # Verify payloads too, including every weight and reference result.
    for folder, manifest in (("EXMO_CT", "MANIFEST.json"), ("EXMO_XRAY", "bundle_manifest.json")):
        root = target / folder
        records = json.loads((root / manifest).read_text(encoding="utf-8"))["files"]
        if isinstance(records, list):
            records = {r["path"]: r for r in records}
        for name, record in records.items():
            if digest(destination(root, name)) != record["sha256"]:
                raise ValueError("Payload checksum mismatch: " + folder + "/" + name)
    root = target / "EXMO_MRI"
    for line in (root / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        expected, name = line.split(maxsplit=1)
        if digest(destination(root, name.lstrip("* "))) != expected:
            raise ValueError("MRI payload checksum mismatch")
    (target.parent / "verified-packages.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("PASS: archive and payload checksums", flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--target", type=Path, default=Path("work/modality-integration/packages"))
    args = parser.parse_args()
    prepare(args.source, args.target)

"""ZIP/import fixtures and extraction checks; no segmentation model is loaded."""
import importlib.util
import json
from pathlib import Path
import stat
import struct
import tempfile
import zipfile

import numpy as np
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, CTImageStorage, MRImageStorage, DigitalXRayImageStorageForPresentation, generate_uid

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("worker", root / "desktop/imaging-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
output = Path(tempfile.mkdtemp(prefix="zip-import-", dir=root / "outputs"))

def extract(archive, **limits):
    return worker.extract_zip({"archive": str(archive), "destination": str(output / generate_uid()), **limits})

def archive(name, members):
    target = output / (name + ".zip")
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for key, data in members:
            z.writestr(key, data)
    return target

def rejected(target, **limits):
    try:
        extract(target, **limits)
    except worker.InputError:
        return
    raise AssertionError("Unsafe/invalid ZIP accepted: " + target.name)

valid = archive("unicode", [("환자/첫/same.dcm", b"first"), ("환자/둘/same.dcm", b"second"), ("README.txt", b"skip"), ("DICOMDIR", b"skip")])
items = extract(valid)
assert [r["name"] for r in items] == ["same.dcm", "same.dcm"]
assert [Path(r["path"]).read_bytes() for r in items] == [b"first", b"second"]
assert len({r["path"] for r in items}) == 2
rejected(valid, maxFiles=1)
rejected(valid, maxBytes=4)
for index, name in enumerate(["../escape.dcm", "/absolute.dcm", "C:/drive.dcm", "..\\escape.dcm", "a:" + "b.dcm", "/".join(["deep"] * 14) + "/image.dcm"]):
    rejected(archive("bad-path-" + str(index), [(name, b"data")]))
link = zipfile.ZipInfo("link.dcm")
link.create_system = 3
link.external_attr = (stat.S_IFLNK | 0o777) << 16
rejected(archive("symlink", [(link, b"target")]))
rejected(archive("nested", [("inner.zip", b"PK")]))
rejected(archive("empty", [("README.txt", b"empty")]))
broken = output / "broken.zip"
broken.write_bytes(b"not a zip")
rejected(broken)
# Set the encrypted flag in both ZIP headers without using a password tool.
encrypted = archive("encrypted", [("image.dcm", b"secret")])
data = bytearray(encrypted.read_bytes())
local, central = data.index(b"PK\x03\x04"), data.index(b"PK\x01\x02")
struct.pack_into("<H", data, local + 6, struct.unpack_from("<H", data, local + 6)[0] | 1)
struct.pack_into("<H", data, central + 8, struct.unpack_from("<H", data, central + 8)[0] | 1)
encrypted.write_bytes(data)
rejected(encrypted)
# CRC corruption must fail rather than publish the truncated archive contents.
crc = output / "crc.zip"
with zipfile.ZipFile(crc, "w", zipfile.ZIP_STORED) as z:
    z.writestr("image.dcm", b"original pixels")
data = bytearray(crc.read_bytes())
start = 30 + struct.unpack_from("<H", data, 26)[0] + struct.unpack_from("<H", data, 28)[0]
data[start] ^= 1
crc.write_bytes(data)
rejected(crc)

fixtures = {}
for modality, sop in [("ct", CTImageStorage), ("mri", MRImageStorage), ("xray", DigitalXRayImageStorageForPresentation)]:
    study = generate_uid()
    source = output / modality
    source.mkdir()
    paths = []
    for series in range(3 if modality == "xray" else 2):
        series_uid, frame_uid = generate_uid(), generate_uid()
        for number in range(1 if modality == "xray" else 3):
            target = source / (str(series) + "-" + str(number) + ".dcm")
            meta = FileMetaDataset()
            meta.TransferSyntaxUID, meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID = ExplicitVRLittleEndian, sop, generate_uid()
            ds = FileDataset(str(target), {}, file_meta=meta, preamble=bytes(128))
            ds.SOPClassUID, ds.SOPInstanceUID = sop, meta.MediaStorageSOPInstanceUID
            ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series_uid, frame_uid
            ds.Modality = {"ct": "CT", "mri": "MR", "xray": "DX"}[modality]
            ds.PatientID, ds.PatientName, ds.IssuerOfPatientID, ds.StudyDate = "00042", "ZIP_FIXTURE", "TEST_SITE", "20261013"
            ds.SeriesDescription = ["LAT_LT", "AP", "LAT_RT"][series] if modality == "xray" else "Water" if modality == "mri" else "Axial"
            ds.ImageOrientationPatient, ds.ImagePositionPatient, ds.PixelSpacing = [1, 0, 0, 0, 1, 0], [0, 0, number * 2], [1, 1]
            ds.Rows, ds.Columns, ds.SamplesPerPixel = 16, 16, 1
            ds.PhotometricInterpretation = "MONOCHROME2"
            ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 0
            if modality == "ct":
                ds.RescaleSlope, ds.RescaleIntercept = 1, -1024
            ds.PixelData = (np.arange(256, dtype=np.uint16) + number).tobytes()
            ds.save_as(target, enforce_file_format=True)
            paths.append((series, number, target))
    target = output / (modality + ".zip")
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for series, number, source_path in reversed(paths):
            z.write(source_path, "환자/" + str(series) + "/" + str(number))
        z.writestr("DICOMDIR", b"directory index")
    items = extract(target)
    groups = worker.dicom_series([Path(r["path"]) for r in items], modality)
    assert len(groups) == (3 if modality == "xray" else 2)
    for group in groups:
        image, metadata = worker.read_dicom(group, modality)
        assert image.GetSize() == (16, 16, 1 if modality == "xray" else 3)
        if modality == "xray":
            assert metadata["patientId"] == "00042" and metadata["studyDate"] == "20261013"
    fixtures[modality] = str(target)
fixtures["broken"] = str(broken)
(output / "fixtures.json").write_text(json.dumps(fixtures), encoding="utf-8")
(root / "outputs/zip-import-fixtures.json").write_text(json.dumps({"directory": str(output), **fixtures}), encoding="utf-8")
print("PASS: nested paths, Unicode, duplicate filenames, count/size limits, traversal, links, encryption, corrupt ZIP/CRC, CT/MRI series reconstruction and X-ray identity")
print(output)

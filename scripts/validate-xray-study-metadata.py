"""Synthetic metadata/import checks; never loads classifier or segmentation weights."""
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import nrrd
import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, DigitalXRayImageStorageForPresentation, generate_uid

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("imaging_worker", root / "desktop/imaging-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
output = Path(tempfile.mkdtemp(prefix="xray-metadata-", dir=root / "outputs"))
identity = {"PatientID": "00042", "IssuerOfPatientID": "TEST_SITE", "InstitutionName": "SYNTHETIC", "StudyDate": "20261012", "StudyInstanceUID": generate_uid()}
paths = []
for view in ("LAT_LT", "AP", "LAT_RT"):
    target = output / (view + ".dcm")
    meta = FileMetaDataset()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.MediaStorageSOPClassUID = DigitalXRayImageStorageForPresentation
    meta.MediaStorageSOPInstanceUID = generate_uid()
    ds = FileDataset(str(target), {}, file_meta=meta, preamble=bytes(128))
    ds.update(identity)
    ds.SOPClassUID, ds.SOPInstanceUID = meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID
    ds.SeriesInstanceUID, ds.Modality, ds.SeriesDescription = generate_uid(), "DX", view
    ds.PatientName, ds.AcquisitionTime = "SYNTHETIC", "120000"
    ds.Rows, ds.Columns = 8, 8
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 0
    ds.PixelSpacing = [1, 1]
    ds.PixelData = np.arange(64, dtype=np.uint16).tobytes()
    ds.save_as(target, enforce_file_format=True)
    image, m = worker.read_dicom([target], "xray")
    assert image.GetSize() == (8, 8, 1)
    assert m["patientId"] == "00042" and m["studyDate"] == "20261012"
    assert m["patientIssuer"] == "TEST_SITE" and m["studyUid"] == identity["StudyInstanceUID"]
    assert m["seriesUid"] == str(ds.SeriesInstanceUID) and m["sopUid"] == str(ds.SOPInstanceUID)
    paths.append(target)
assert len(worker.dicom_series(paths, "xray")) == 3
source = output / "with_metadata.nrrd"
header = {"space": "left-posterior-superior", "space directions": np.eye(3), "space origin": np.zeros(3)}
nrrd.write(str(source), np.arange(64, dtype=np.uint16).reshape(8, 8, 1), {**header, **identity})
unknown = output / "patient42_AP_20261012.nrrd"
nrrd.write(str(unknown), np.arange(64, dtype=np.uint16).reshape(8, 8, 1), header)
classifier = SimpleNamespace(pipeline=None, process=lambda *_: {"route_to_segmentation": "AP"})
records = worker.inspect({"analysis": "xray", "destination": str(output / "import"), "paths": [str(source), str(unknown)]}, root, classifier)
assert all(r["ready"] for r in records), records
assert records[0]["metadata"]["patientId"] == "00042"
assert records[0]["metadata"]["studyDate"] == "20261012"
assert not records[1]["metadata"].get("patientId") and not records[1]["metadata"].get("studyDate")
print("PASS: DICOM patient/study/series/SOP identity, single projection preservation, NRRD import metadata and no filename identity inference")

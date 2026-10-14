"""Recover legacy catalog metadata into a local sidecar; original scans/results stay unchanged.

Usage: CT-engine python scripts/recover-source-metadata.py --storage <imaging> [--apply]
Only a retained private NRRD or a DICOM frame matching saved UIDs AND SHA256 is trusted.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil

import nrrd
import pydicom

spec = importlib.util.spec_from_file_location("imaging_worker", Path(__file__).resolve().parents[1] / "desktop/imaging-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def recover(records, storage):
    found, pending = {}, {}
    for record in records:
        ident = record["id"]
        source = Path(record["input"]) if record.get("input") else None
        if source:
            for candidate in dict.fromkeys([source, source.parent / "input.nrrd"]):
                if candidate.suffix.lower() != ".nrrd" or not candidate.resolve().is_relative_to(storage.resolve()):
                    continue
                try:
                    metadata = worker.xray_study_metadata(nrrd.read_header(str(candidate)))
                    if metadata:
                        found[ident] = {"metadata": metadata, "evidence": {"kind": "retained-nrrd-header", "source": str(candidate)}}
                        break
                except (OSError, ValueError, nrrd.NRRDError):
                    continue
        proof = record.get("sourceProof") or {}
        folder = record.get("reviewSetup", {}).get("sourceFolder")
        if ident not in found and folder and proof.get("frames") and proof.get("study_uid") and proof.get("series_uid"):
            pending.setdefault(folder, []).append(record)
    for folder, waiting in pending.items():
        targets = {}
        for record in waiting:
            frame = record["sourceProof"]["frames"][0]
            if frame.get("sop_uid") and frame.get("sha256"):
                targets.setdefault(frame["sop_uid"], []).append(record)
        for candidate in Path(folder).rglob("*"):
            if not candidate.is_file() or not targets:
                continue
            try:
                header = pydicom.dcmread(candidate, stop_before_pixels=True)
            except (OSError, pydicom.errors.InvalidDicomError):
                continue
            sop = str(getattr(header, "SOPInstanceUID", ""))
            if sop not in targets:
                continue
            digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
            for record in targets[sop][:]:
                proof = record["sourceProof"]
                if (digest != proof["frames"][0]["sha256"] or str(getattr(header, "StudyInstanceUID", "")) != proof["study_uid"]
                        or str(getattr(header, "SeriesInstanceUID", "")) != proof["series_uid"]):
                    continue
                found[record["id"]] = {"metadata": worker.xray_study_metadata(header),
                    "evidence": {"kind": "verified-dicom-frame", "source": str(candidate), "sopUid": sop, "sha256": digest}}
                targets[sop].remove(record)
            if not targets[sop]:
                del targets[sop]
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--storage", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    storage = args.storage.resolve()
    records = {r["id"]: r for r in json.loads((storage / "library.json").read_text(encoding="utf8"))}
    for publication in (storage / "runs").glob("*/published.json"):
        record = json.loads(publication.read_text(encoding="utf8")).get("record")
        if record:
            records.setdefault(record["id"], record)
    recovered = recover(records.values(), storage)
    table = storage / "source-metadata.json"
    data = json.loads(table.read_text(encoding="utf8")) if table.exists() else {"version": 1, "records": {}}
    assert data["version"] == 1 and isinstance(data["records"], dict)
    data["records"].update(recovered)
    if args.apply:
        if table.exists():
            shutil.copyfile(table, table.with_suffix(".backup-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".json"))
        temporary = table.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf8")
        temporary.replace(table)
    print(json.dumps({"applied": args.apply, "records": len(records), "recovered": len(recovered),
        "ctRecovered": sum(records[k]["analysis"] == "ct" for k in recovered),
        "nrrdHeaders": sum(r["evidence"]["kind"] == "retained-nrrd-header" for r in recovered.values()),
        "verifiedDicomFrames": sum(r["evidence"]["kind"] == "verified-dicom-frame" for r in recovered.values())}))


if __name__ == "__main__":
    main()

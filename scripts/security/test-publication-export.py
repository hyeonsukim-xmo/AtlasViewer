"""Synthetic protected-result transfer fixture; never uses a patient input."""
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'desktop'))
import numpy as np
import SimpleITK as sitk
import artifact_store
from publication_export import export

message = json.loads(sys.stdin.read())
root = Path(message.pop('fixtureRoot'))
store = artifact_store.install(root, b'\x19' * 32)
artifact_store.install_image_io(store)
image = sitk.GetImageFromArray(np.ones((130, 64, 64), dtype=np.uint16))
image.SetSpacing((1.0, 1.0, 2.0))
mask = root / 'mask.nrrd'
sitk.WriteImage(image, str(mask))
snapshot = dict(mask=str(mask), _snapshot=dict(snapshotDigest=message['snapshotDigest']))
result = export(message, lambda *args, **kwargs: snapshot, None)
with artifact_store._open(mask, 'rb') as stream:
    assert stream.read(8) == artifact_store.MAGIC
print(json.dumps(result))

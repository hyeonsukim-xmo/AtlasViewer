"""Synthetic masks only: encrypted finalization, bilateral metrics, overlay and deferred 3D."""
import importlib.util
import json
from pathlib import Path
import secrets
import sys
import tempfile
import uuid
import numpy as np
import SimpleITK as sitk
import nibabel as nib

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'desktop'))
import artifact_store as A

engine = Path(sys.argv[1]).resolve() / 'packages' if len(sys.argv) > 1 else ROOT / 'work/security-delivery-v2/packages'
spec = importlib.util.spec_from_file_location('worker', ROOT / 'desktop/imaging-worker.py')
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
palette = {row['id']: row for row in json.loads((ROOT / 'dist-desktop/imaging-palette.json').read_text())}
report = {}
with tempfile.TemporaryDirectory() as directory:
    base = Path(directory); store = A.install(base / 'runs', secrets.token_bytes(32)); A.install_image_io(store)
    for analysis, route in [('ct', None), ('mri', None), ('xray', 'AP'), ('xray', 'LAT_LT'), ('xray', 'LAT_RT')]:
        identity = str(uuid.uuid4()); result = base / 'runs' / identity / 'output'; folder = result / 'raw' if analysis == 'mri' else result
        folder.mkdir(parents=True)
        labels = np.zeros((24 if analysis != 'xray' else 1, 24, 32), dtype=np.uint8)
        labels[:, 6:18, 3:12] = 1; labels[:, 6:18, 20:29] = 1
        source = sitk.GetImageFromArray(np.arange(labels.size, dtype=np.float32).reshape(labels.shape)); source.SetSpacing((1., 1., 2.))
        input_path = base / (identity + '.nrrd'); sitk.WriteImage(source, str(input_path), True)
        mask = sitk.GetImageFromArray(labels); mask.CopyInformation(source)
        if analysis == 'ct':
            affine = np.diag([-1., -1., 2., 1.]); nii = nib.Nifti1Image(labels.transpose(2, 1, 0), affine)
            nii.header.set_xyzt_units('mm'); nib.save(nii, folder / 'mask.nii.gz')
        else:
            sitk.WriteImage(mask, str(folder / ('mask.seg.nrrd' if route == 'AP' else 'mask.nrrd')), True)
        if analysis == 'mri':
            entropy = sitk.Cast(mask, sitk.sitkFloat32) * .1
            sitk.WriteImage(entropy, str(result / 'entropy.nrrd'), True)
            ontology = json.loads((engine / 'EXMO_MRI/configs/dataset/mri_thigh_29class_v001.json').read_text())['labels']
            metrics = {'classes':[{'label_id':r['id'], 'voxel_count':int(np.count_nonzero(labels == r['id'])), 'volume_ml':float(np.count_nonzero(labels == r['id'])) * .002} for r in ontology if r['id']]}
            worker.write_json(folder / 'metrics.json', metrics)
        worker.write_json(result / 'desktop-complete.json', {'complete':True, 'seconds':0})
        record = {'id':identity, 'analysis':analysis, 'input':str(input_path), 'name':'synthetic', 'metadata':{}, 'classification':{'route_to_segmentation':route}}
        publication = worker.finalize({'id':identity, 'record':record, 'result':str(result), 'createdAt':'2026-10-15T00:00:00Z', 'deferMesh':True}, engine.parent, palette)
        assert publication['summary']['rows'][0]['count'] == int(np.count_nonzero(labels == 1))
        for view in ('axial', 'coronal', 'sagittal') if analysis != 'xray' else ('axial',):
            preview = worker.preview({'record':record, 'mask':publication['mask'], 'rows':publication['summary']['rows'], 'view':view})
            assert preview['image'].startswith('data:image/png;base64,')
        if analysis != 'xray':
            assert publication['summary']['meshState'] == 'pending'
            worker.finish_mesh(publication); assert publication['summary']['meshBytes'] > 0
        if analysis == 'mri':
            before = worker.digest(folder / 'mask.nrrd')
            candidate = worker.finalize({'id':identity, 'record':record, 'result':str(result), 'createdAt':'2026-10-15T00:00:00Z', 'deferMesh':True, 'variant':'strong'}, engine.parent, palette)
            assert candidate['summary']['variant'] == 'strong'
            assert worker.digest(folder / 'mask.nrrd') == before
        for file in result.rglob('*'):
            if file.is_file() and store.managed(file):
                with A._open(file, 'rb') as stream: assert stream.read(8) == A.MAGIC, file
        report[route or analysis] = {'metrics':True, 'overlay':True, 'encryptedArtifacts':True, 'deferred3D':analysis != 'xray'}
print(json.dumps({'syntheticOnly':True, 'results':report}))

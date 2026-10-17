"""Synthetic result fixture and real mutation guard/reader, without model inference."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'desktop'))
import artifact_store
from model_security import ModelGuard
from result_security import MutationGuard, complete, admit_completion, read_snapshot, seal_snapshot
import numpy as np
import SimpleITK as sitk

parser = argparse.ArgumentParser()
parser.add_argument('--engine', type=Path); parser.add_argument('--policy', type=Path); parser.add_argument('--root', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('result_worker_test', root / 'desktop/imaging-worker.py')
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
guard = ModelGuard(json.loads(args.policy.read_text()), args.engine)
mutation = MutationGuard(guard, worker.make_mesh)

for line in sys.stdin:
    m = json.loads(line)
    try:
        operation = m['operation']
        if operation == 'storage_init':
            artifact_store.initialize(m); continue
        if operation == 'fixture':
            ident = str(uuid.uuid4()); result = args.root / 'runs' / ident / 'output'; result.mkdir(parents=True)
            data = np.zeros((12, 12, 12), dtype=np.uint8); data[2:10, 2:10, 2:10] = 1
            mask = sitk.GetImageFromArray(data)
            source = args.root / 'input.nrrd'; sitk.WriteImage(mask, str(source))
            import nibabel as nib
            nib.save(nib.Nifti1Image(data.transpose(2, 1, 0), np.diag([-1., -1., 1., 1.])), result / 'mask.nii.gz')
            side = result / 'laterality-raw-femur_components_lps_v1'; side.mkdir()
            sitk.WriteImage(mask, str(side / 'mask.nrrd'))
            record = {'analysis': 'ct', 'id': 'synthetic', 'input': str(source), 'solutionId': 'exmo.thigh.ct', 'workflowId': 'thigh-ct-v1'}
            parts = [{'id': 'synthetic', 'label': 1, 'faceBudget': 35000}]
            worker.write_json(side / 'metrics.json', {'parts': parts, 'meshBytes': None})
            worker.write_json(result / 'desktop-complete.json', {'complete': True})
            complete(result, {**record, 'route': None}, ident)
            values = {'id': ident, 'record': record, 'result': str(result)}
            admit_completion(values)
            try:
                admit_completion(values)
                raise AssertionError('Completion replay accepted')
            except FileExistsError:
                pass
            publication = {'summary': {'id': ident, 'analysis': 'ct', 'variant': 'raw', 'route': None, 'unit': 'cm³', 'rows': [{'id': 'synthetic', 'label': 1, 'count': 512, 'value': .512}], 'parts': parts, 'laterality': {'method': 'femur_components_lps_v1'}, 'meshState': 'pending', 'timings': {}},
                           'record': record, 'result': str(result), 'mask': str(result / 'mask.nii.gz'), 'sideMask': str(side / 'mask.nrrd'), 'mesh': None}
            value = seal_snapshot(publication, worker.make_mesh)
        elif operation == 'mutation_challenge': value = mutation.challenge(m['runId'], m['job'])
        elif operation == 'admit':
            mutation.admit(m['runId'], m['job'], m['authorization']); value = True
        elif operation == 'read': value = read_snapshot(m['result'], 'raw', worker.make_mesh)
        elif operation == 'mesh': value = worker.finish_mesh(m['publication'])
        else: raise ValueError('Unknown test operation')
        print(json.dumps({'id': m['id'], 'result': value}, ensure_ascii=False), flush=True)
    except Exception as error:
        import traceback
        frame = traceback.extract_tb(error.__traceback__)[-2:]
        location = ','.join(f'{Path(f.filename).name}:{f.lineno}' for f in frame)
        print(json.dumps({'id': m['id'], 'error': f'Result authorization rejected: {operation} {type(error).__name__} {location}'}), flush=True)

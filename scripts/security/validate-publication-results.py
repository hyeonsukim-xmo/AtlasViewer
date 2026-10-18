"""Read existing QA snapshots; emit encrypted transfer artifacts, never rerun inference."""
import base64
import importlib.util
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'desktop'))
import artifact_store
from result_security import read_snapshot
from publication_export import export

request = json.loads(sys.stdin.read())
store = request.pop('storage')
artifact_store.install(store['root'], base64.urlsafe_b64decode(store['key'] + '='))
artifact_store.install_image_io(artifact_store.current())
spec = importlib.util.spec_from_file_location('imaging_worker', Path(__file__).resolve().parents[2] / 'desktop/imaging-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
fixed = read_snapshot(request['result'], request['variant'], worker.make_mesh, verify_recipe=False)
request['snapshotDigest'] = fixed['_snapshot']['snapshotDigest']
value = export(request, read_snapshot, worker.make_mesh)
print(json.dumps(value, allow_nan=False))

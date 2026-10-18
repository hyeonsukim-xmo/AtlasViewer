"""App-owned export helper; archived readers keep their original display recipe."""
import json
import sys
import artifact_store
from diagnostics import failure
from publication_export import export
from result_security import read_snapshot

for line in sys.stdin:
    message = {}
    try:
        message = json.loads(line)
        if message.get('operation') == 'storage_init':
            artifact_store.initialize(message)
            continue
        if message.get('operation') != 'publication_export':
            raise ValueError('Unsupported publication operation')
        # Snapshot adoption was already completed through the original reader, never replace its recipe here.
        def fixed(result, variant, *args, **kwargs):
            return read_snapshot(result, variant, None, adopt=False, verify_recipe=False)
        result = export(message, fixed, None)
        response = {'id': message['requestId'], 'result': result}
    except Exception as error:
        response = {'id': message.get('requestId'), **failure(error, 'publication_export', message.get('requestId'))}
    print(json.dumps(response, ensure_ascii=False, allow_nan=False), flush=True)

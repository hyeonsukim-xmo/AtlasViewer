import contextlib
import errno
import io
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'desktop'))
from diagnostics import failure

for error, expected in [(FileNotFoundError(errno.ENOENT, 'private-path'), 'FILE_MISSING'),
                        (PermissionError(errno.EACCES, 'private-path'), 'ACCESS_DENIED'),
                        (OSError(errno.ENOSPC, 'private-path'), 'DISK_FULL'),
                        (MemoryError('private-data'), 'MEMORY'),
                        (RuntimeError('CUDA out of memory'), 'GPU_MEMORY'),
                        (RuntimeError('CUDA is unavailable; CPU fallback is disabled'), 'GPU_UNAVAILABLE'),
                        (KeyError('space origin'), 'RESULT_PROCESS')]:
    log = io.StringIO()
    with contextlib.redirect_stderr(log):
        result = failure(error, 'finalize', 'case-a')
    assert result['errorCode'] == expected, result
    assert result['reference'] in log.getvalue()
    assert 'private-' not in result['error']
with contextlib.redirect_stderr(io.StringIO()):
    result = failure(ValueError('known geometry rule'), 'finalize', input_error=True)
assert result['errorCode'] == 'RESULT_INVALID' and result['error'] == 'known geometry rule'
log = io.StringIO()
with contextlib.redirect_stderr(log):
    result = failure(ValueError('secret-key'), 'model_challenge', code='AUTHORIZATION')
assert 'secret-key' not in log.getvalue() and 'secret-key' not in str(result)
print('PASS: Python resource/GPU categories, result validation, private trace correlation, no authorization secrets')
